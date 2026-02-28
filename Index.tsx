import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Compass, Route, Crosshair, Wind, Brain, Play, Square,
  Settings2, Trash2, MapPin, Timer, Flag, Wifi, WifiOff, X, ChevronDown,
  Map, BarChart2, ZoomIn, ZoomOut, Plus, Minus
} from 'lucide-react';
import { useWifiConnection, WifiConfig, Protocol, ConnectionStatus, DataPacket } from '@/hooks/useWifiConnection';

// ── PERCORSI UFFICIALI (IdR 43° Camp. Invernale RYC – Allegato B) ─────────────
const COURSES = {
  orc2: {
    id: 'orc2', name: 'ORC / BLU — 2 Giri',
    sequence: ['P', '1', '2', '3', '1', '2', '3', 'A1'],
    color: 'yellow', label: 'Boe Gialle', signal: '2° Ripetitore CIS',
  },
  orc3: {
    id: 'orc3', name: 'ORC / BLU — 3 Giri',
    sequence: ['P', '1', '2', '3', '1', '2', '3', '1', '2', '3', 'A1'],
    color: 'yellow', label: 'Boe Gialle', signal: '3° Ripetitore CIS',
  },
  gialla2: {
    id: 'gialla2', name: 'GIALLA — Bastone 2 Giri',
    sequence: ['P', '1a', '2a', '1a', '2a', 'A2'],
    color: 'orange', label: 'Boe Arancioni', signal: 'Bandiera Bianca',
  },
  gialla1: {
    id: 'gialla1', name: 'GIALLA — Triangolo 1 Giro',
    sequence: ['P', '1a', '3a', '2a', 'A2'],
    color: 'orange', label: 'Boe Arancioni', signal: 'Bandiera Celeste',
  },
};

const ALL_MARKS = ['1', '1a', '2', '2a', '3', '3a', 'A1', 'A2'];
const RACE_AREA_CENTER = { lat: 44 + 28 / 60 + 12 / 3600, lon: 12 + 19 / 60 + 3 / 3600 };

// ── MATEMATICA ────────────────────────────────────────────────────────────────
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

const calcDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 3440.065;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const calcBearing = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

const angleDiff = (a: number, b: number): number => ((a - b + 540) % 360) - 180;

const formatTime = (s: number | null): string => {
  if (s === null || isNaN(s)) return '--:--';
  const sign = s < 0 ? '-' : '';
  const abs = Math.abs(Math.round(s));
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
};

/** Proiezione ortogonale del punto P sul segmento AB. Ritorna parametro t∈[0,1] e distanza in NM */
const projectPointOnSegment = (
  pLat: number, pLon: number,
  aLat: number, aLon: number,
  bLat: number, bLon: number
): { t: number; distNM: number; projLat: number; projLon: number } => {
  const cosLat = Math.cos(toRad((aLat + bLat) / 2));
  const ax = aLon * cosLat, ay = aLat;
  const bx = bLon * cosLat, by = bLat;
  const px = pLon * cosLat, py = pLat;
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  const t = ab2 === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));
  const projLon = (ax + t * abx) / cosLat;
  const projLat = ay + t * aby;
  const distNM = calcDistance(pLat, pLon, projLat, projLon);
  return { t, distNM, projLat, projLon };
};

// ── SMOOTH ROTATION ───────────────────────────────────────────────────────────
const useSmoothRotation = (targetAngle: number) => {
  const [rotation, setRotation] = useState(targetAngle);
  const prevRef = useRef(targetAngle);
  useEffect(() => {
    let diff = targetAngle - (prevRef.current % 360);
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    const next = prevRef.current + diff;
    setRotation(next);
    prevRef.current = next;
  }, [targetAngle]);
  return rotation;
};

// ── TIPI ──────────────────────────────────────────────────────────────────────
interface BoatData {
  HDG: number; COG: number; SOG: number; STW: number;
  AWS: number; AWA: number;
  TWS: number; TWA: number; TWD: number;
  lat: number; lon: number;
  depth: number; waterTemp: number;
}
interface MarkPos { lat: number; lon: number }
interface PolarTarget { tws: number; upwindAngle: number; upwindVmg: number; downwindAngle: number; downwindVmg: number }
interface PolarSample { tws: number; twa: number; sog: number }

// ── STATUS WIFI ───────────────────────────────────────────────────────────────
const statusColor: Record<ConnectionStatus, string> = {
  disconnected: 'bg-slate-500', connecting: 'bg-yellow-400 animate-pulse',
  connected: 'bg-green-400 animate-pulse', error: 'bg-red-500',
};
const statusLabel: Record<ConnectionStatus, string> = {
  disconnected: 'DISCONNESSO', connecting: 'CONNESSIONE...', connected: 'CONNESSO', error: 'ERRORE',
};

// ══════════════════════════════════════════════════════════════════════════════
// WIFI PANEL
// ══════════════════════════════════════════════════════════════════════════════
interface WifiPanelProps {
  onClose: () => void; onConnect: (cfg: WifiConfig) => void; onDisconnect: () => void;
  status: ConnectionStatus; errorMsg: string | null;
  bytesReceived: number; messagesReceived: number;
  config: WifiConfig; onConfigChange: (cfg: WifiConfig) => void;
  packets: DataPacket[]; clearPackets: () => void;
}
const WifiPanel = ({ onClose, onConnect, onDisconnect, status, errorMsg, bytesReceived, messagesReceived, config, onConfigChange, packets, clearPackets }: WifiPanelProps) => {
  const isActive = status === 'connected' || status === 'connecting';
  const [showConsole, setShowConsole] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showConsole && consoleRef.current) {
      consoleRef.current.scrollTop = 0;
    }
  }, [packets, showConsole]);

  const getLineColor = (data: string) => {
    if (data.startsWith('[SYS]')) return 'text-cyan-400';
    if (data.includes('$GPRMC') || data.includes('$GPGLL')) return 'text-green-400';
    if (data.includes('MWV') || data.includes('MWD')) return 'text-amber-400';
    if (data.includes('VHW') || data.includes('VTG')) return 'text-blue-400';
    if (data.includes('HDT')) return 'text-purple-400';
    if (data.includes('DBT') || data.includes('MTW')) return 'text-teal-400';
    return 'text-slate-300';
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="relative bg-slate-900 border border-slate-700 rounded-2xl p-5 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2"><Wifi className="text-blue-400 w-5 h-5" /><h2 className="text-white font-bold text-lg">CONNESSIONE Wi-Fi</h2></div>
          <button onClick={onClose} className="text-slate-500 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        {/* Status bar */}
        <div className="flex items-center gap-2 mb-4 bg-slate-800 rounded-lg px-4 py-2 border border-slate-700">
          <div className={`w-2.5 h-2.5 rounded-full ${statusColor[status]}`} />
          <span className="text-sm font-mono text-slate-300">{statusLabel[status]}</span>
          {status === 'connected' && <span className="ml-auto text-xs text-slate-500 font-mono">{messagesReceived} msg · {(bytesReceived / 1024).toFixed(1)} KB</span>}
        </div>

        {errorMsg && <div className="mb-4 bg-red-950/60 border border-red-700 rounded-lg p-3 text-sm text-red-400">{errorMsg}</div>}

        {/* Config */}
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-slate-400 font-semibold tracking-wider mb-1.5 uppercase">Host / IP</label>
            <input type="text" value={config.host} onChange={e => onConfigChange({ ...config, host: e.target.value })}
              placeholder="es. 192.168.4.1" disabled={isActive}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white font-mono text-sm placeholder:text-slate-600 focus:outline-none focus:border-blue-500 disabled:opacity-50" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 font-semibold tracking-wider mb-1.5 uppercase">Porta</label>
              <input type="number" min={1} max={65535} value={config.port}
                onChange={e => onConfigChange({ ...config, port: parseInt(e.target.value) || 2000 })} disabled={isActive}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 font-semibold tracking-wider mb-1.5 uppercase">Protocollo</label>
              <div className="flex gap-2">
                {(['TCP', 'UDP'] as Protocol[]).map(p => (
                  <button key={p} onClick={() => !isActive && onConfigChange({ ...config, protocol: p })}
                    disabled={isActive}
                    className={`flex-1 py-2.5 rounded-lg font-mono text-sm font-bold border transition-all
                      ${config.protocol === p
                        ? 'bg-blue-600/20 border-blue-500 text-blue-400'
                        : 'bg-slate-800 border-slate-700 text-slate-500 hover:border-slate-500'}
                      ${isActive ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Info box */}
          <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3 text-xs text-slate-400 leading-relaxed">
            <strong className="text-slate-300">WebSocket:</strong> <code className="bg-slate-800 px-1 rounded text-blue-400">
              ws://{config.host || 'host'}:{config.port}{config.protocol === 'UDP' ? '/udp' : ''}
            </code>
            <p className="mt-1.5 text-slate-500">
              {config.protocol === 'TCP'
                ? 'Il server deve esporre un endpoint WebSocket con streaming NMEA 0183 o JSON N2K.'
                : '⚠ I browser non supportano UDP nativo. Serve un bridge WebSocket↔UDP sul dispositivo.'}
            </p>
          </div>
        </div>

        {/* Connect/Disconnect */}
        <div className="flex gap-3 mt-5">
          {!isActive
            ? <button onClick={() => onConnect(config)} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(59,130,246,0.3)]"><Wifi className="w-4 h-4" /> CONNETTI</button>
            : <button onClick={onDisconnect} className="flex-1 bg-red-600 hover:bg-red-500 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(239,68,68,0.3)]"><WifiOff className="w-4 h-4" /> DISCONNETTI</button>}
          <button onClick={onClose} className="px-4 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl border border-slate-700">Chiudi</button>
        </div>

        {/* Raw Data Console */}
        <div className="mt-5 border-t border-slate-700 pt-4">
          <button onClick={() => setShowConsole(p => !p)}
            className="flex items-center justify-between w-full text-sm font-bold text-slate-300 hover:text-white transition-colors">
            <span className="flex items-center gap-2">
              <span className="font-mono text-[10px] bg-slate-800 text-green-400 px-2 py-0.5 rounded border border-slate-700">RAW</span>
              Console NMEA ({packets.length})
            </span>
            <ChevronDown size={16} className={`transition-transform ${showConsole ? 'rotate-180' : ''}`} />
          </button>
          {showConsole && (
            <div className="mt-3">
              <div className="flex justify-end mb-2">
                <button onClick={clearPackets} className="text-[10px] text-red-400 hover:text-red-300 font-mono">Pulisci Console</button>
              </div>
              <div ref={consoleRef} className="bg-slate-950 border border-slate-800 rounded-lg p-2 h-48 overflow-y-auto font-mono text-[10px] leading-relaxed space-y-0.5">
                {packets.length === 0 ? (
                  <div className="text-slate-600 text-center py-8">In attesa di dati NMEA...</div>
                ) : (
                  packets.slice(0, 100).map(pkt => (
                    <div key={pkt.id} className="flex gap-2">
                      <span className="text-slate-600 shrink-0">{pkt.timestamp.toTimeString().slice(0, 8)}</span>
                      <span className={`break-all ${getLineColor(pkt.data)}`}>{pkt.data}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// COMPASS DISPLAY (360° full ring – Heading Up)
// ══════════════════════════════════════════════════════════════════════════════
interface CompassDisplayProps { boat: BoatData; targetBearing: number | null; racePhase: string; targetId: string }
const CompassDisplay = ({ boat, targetBearing, racePhase, targetId }: CompassDisplayProps) => {
  const smoothHdg = useSmoothRotation(-boat.HDG);
  const smoothCog = useSmoothRotation(boat.COG - boat.HDG);
  const smoothAwa = useSmoothRotation(boat.AWA);            // AWA è già relativo alla prua
  const smoothTwa = useSmoothRotation(boat.TWA);            // TWA è già relativo alla prua
  const smoothTgt = useSmoothRotation(targetBearing !== null ? targetBearing - boat.HDG : 0);

  // 36 ticks every 10°, major every 30° with label
  const ticks = Array.from({ length: 36 }, (_, i) => {
    const angle = i * 10;
    const isMajor = angle % 30 === 0;
    const label = angle === 0 ? 'N' : angle === 90 ? 'E' : angle === 180 ? 'S' : angle === 270 ? 'W' : String(angle);
    return (
      <g key={angle} transform={`rotate(${angle} 150 150)`}>
        <line x1="150" y1="8" x2="150" y2={isMajor ? '26' : '17'}
          stroke={isMajor ? '#e2e8f0' : '#334155'} strokeWidth={isMajor ? '2' : '1'} />
        {isMajor && (
          <text x="150" y="42" fill="#94a3b8" fontSize="11" fontFamily="monospace"
            textAnchor="middle" transform={`rotate(${-angle} 150 35)`}>{label}</text>
        )}
      </g>
    );
  });

  return (
    <div className="relative w-80 h-80 mx-auto flex items-center justify-center">
      {/* ── Rotating compass ring (full 360°) ── */}
      <svg viewBox="0 0 300 300" className="absolute inset-0 w-full h-full"
        style={{ transform: `rotate(${smoothHdg}deg)`, transition: 'transform 0.35s linear' }}>
        <circle cx="150" cy="150" r="148" fill="#0f172a" stroke="#1e293b" strokeWidth="2" />
        {/* Cardinal colour arcs for orientation */}
        <circle cx="150" cy="150" r="140" fill="none" stroke="#1e3a5f" strokeWidth="6"
          strokeDasharray="4 18" strokeLinecap="round" />
        {ticks}
        {/* North indicator */}
        <polygon points="150,8 145,22 155,22" fill="#ef4444" />
      </svg>

      {/* ── Fixed overlay: wind / COG arrows ── */}
      <svg viewBox="0 0 300 300" className="absolute inset-0 w-full h-full">
        <defs>
          <filter id="gc"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="ga"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>

        {/* COG dashed purple vector */}
        <g style={{ transform: `rotate(${smoothCog}deg)`, transformOrigin: '150px 150px', transition: 'transform 0.35s linear' }}>
          <line x1="150" y1="150" x2="150" y2="22" stroke="#a855f7" strokeWidth="2" strokeDasharray="6,4" opacity="0.9"/>
          <polygon points="150,12 145,28 155,28" fill="#a855f7"/>
        </g>

        {/* AWA – apparent wind (cyan) */}
        <g style={{ transform: `rotate(${smoothAwa}deg)`, transformOrigin: '150px 150px', transition: 'transform 0.35s linear' }}>
          <line x1="150" y1="150" x2="150" y2="26" stroke="#22d3ee" strokeWidth="1.5" opacity="0.5"/>
          <polygon points="150,10 141,30 159,30" fill="#22d3ee" filter="url(#gc)"/>
        </g>

        {/* TWA – true wind (amber) */}
        <g style={{ transform: `rotate(${smoothTwa}deg)`, transformOrigin: '150px 150px', transition: 'transform 0.35s linear' }}>
          <line x1="150" y1="150" x2="150" y2="26" stroke="#f59e0b" strokeWidth="1.5" opacity="0.5"/>
          <polygon points="150,8 137,32 150,22 163,32" fill="#f59e0b" filter="url(#ga)"/>
        </g>

        {/* Target mark bearing */}
        {racePhase === 'next' && targetBearing !== null && (
          <g style={{ transform: `rotate(${smoothTgt}deg)`, transformOrigin: '150px 150px', transition: 'transform 0.35s linear' }}>
            <circle cx="150" cy="20" r="9" fill="#ef4444" stroke="#fff" strokeWidth="2"/>
            <text x="150" y="24" fill="#fff" fontSize="8" textAnchor="middle" fontWeight="bold">{targetId}</text>
          </g>
        )}

        {/* Fixed boat hull at centre */}
        <g transform="translate(150,150)">
          <path d="M0 -36 C12 -16, 12 16, 8 36 L-8 36 C-12 16, -12 -16, 0 -36 Z"
            fill="#1e293b" stroke="#e2e8f0" strokeWidth="2"/>
          <line x1="0" y1="-36" x2="0" y2="36" stroke="#475569" strokeWidth="1"/>
        </g>
      </svg>

      {/* HDG digital overlay */}
      <div className="absolute top-7 bg-slate-950/90 px-4 py-1 rounded-full border border-slate-700 z-50 shadow-lg pointer-events-none">
        <span className="text-2xl font-black text-white font-mono">{boat.HDG.toFixed(0)}°</span>
      </div>
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// TACTICAL MAP (Tab 7)
// ══════════════════════════════════════════════════════════════════════════════
interface TacticalMapProps { boat: BoatData; marks: Record<string, MarkPos>; rcBoat: MarkPos | null; pinEnd: MarkPos | null }
const TacticalMap = ({ boat, marks, rcBoat, pinEnd }: TacticalMapProps) => {
  const [zoom, setZoom] = useState(1.0); // px per NM, starts at moderate zoom
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Collect all geo points
  const allPoints: { lat: number; lon: number }[] = [{ lat: boat.lat, lon: boat.lon }];
  Object.values(marks).forEach(m => allPoints.push(m));
  if (rcBoat) allPoints.push(rcBoat);
  if (pinEnd) allPoints.push(pinEnd);

  const pxPerNM = 220 * zoom;

  // Lat/lon → canvas px (Mercator-ish flat projection centred on boat)
  const toCanvas = useCallback((lat: number, lon: number, cx: number, cy: number) => {
    const cosLat = Math.cos(toRad(boat.lat));
    const dx = (lon - boat.lon) * 60 * cosLat; // NM E/W
    const dy = (lat - boat.lat) * 60;            // NM N/S
    return { x: cx + dx * pxPerNM, y: cy - dy * pxPerNM };
  }, [boat.lat, boat.lon, pxPerNM]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;

    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);

    // Grid lines every 0.1 NM
    const gridNM = 0.1;
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    for (let dx = -2; dx <= 2; dx += gridNM) {
      const p1 = toCanvas(boat.lat - 2, boat.lon + dx, cx, cy);
      const p2 = toCanvas(boat.lat + 2, boat.lon + dx, cx, cy);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }
    for (let dy = -2; dy <= 2; dy += gridNM) {
      const p1 = toCanvas(boat.lat + dy, boat.lon - 2, cx, cy);
      const p2 = toCanvas(boat.lat + dy, boat.lon + 2, cx, cy);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }

    // Start line (RC → Pin)
    if (rcBoat && pinEnd) {
      const a = toCanvas(rcBoat.lat, rcBoat.lon, cx, cy);
      const b = toCanvas(pinEnd.lat, pinEnd.lon, cx, cy);
      ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Mark connections (course order)
    const markKeys = Object.keys(marks);
    if (markKeys.length > 1) {
      ctx.strokeStyle = '#334155'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
      ctx.beginPath();
      markKeys.forEach((k, i) => {
        const p = toCanvas(marks[k].lat, marks[k].lon, cx, cy);
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      });
      ctx.stroke(); ctx.setLineDash([]);
    }

    // Draw marks
    const MARK_COLORS: Record<string, string> = {
      '1': '#facc15', '2': '#facc15', '3': '#facc15',
      '1a': '#fb923c', '2a': '#fb923c', '3a': '#fb923c',
      'A1': '#facc15', 'A2': '#fb923c', 'P': '#94a3b8',
    };
    Object.entries(marks).forEach(([id, pos]) => {
      const p = toCanvas(pos.lat, pos.lon, cx, cy);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
      ctx.fillStyle = MARK_COLORS[id] ?? '#94a3b8';
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#000'; ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(id, p.x, p.y);
    });

    // RC Boat (green square)
    if (rcBoat) {
      const p = toCanvas(rcBoat.lat, rcBoat.lon, cx, cy);
      ctx.fillStyle = '#22c55e'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.fillRect(p.x - 8, p.y - 8, 16, 16); ctx.strokeRect(p.x - 8, p.y - 8, 16, 16);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('RC', p.x, p.y);
    }
    // Pin end (red diamond)
    if (pinEnd) {
      const p = toCanvas(pinEnd.lat, pinEnd.lon, cx, cy);
      ctx.fillStyle = '#f43f5e'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x, p.y - 10); ctx.lineTo(p.x + 8, p.y); ctx.lineTo(p.x, p.y + 10); ctx.lineTo(p.x - 8, p.y); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('PIN', p.x, p.y);
    }

    // Boat icon (rotated triangle at centre)
    const hdgRad = toRad(boat.HDG);
    const bx = cx, by = cy;
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(hdgRad);
    ctx.fillStyle = '#60a5fa'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -14); ctx.lineTo(8, 12); ctx.lineTo(0, 7); ctx.lineTo(-8, 12); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();

    // Scale bar (0.1 NM)
    const scaleLen = pxPerNM * 0.1;
    ctx.fillStyle = '#94a3b8'; ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 2; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(W - 20 - scaleLen, H - 20); ctx.lineTo(W - 20, H - 20); ctx.stroke();
    ctx.font = '9px monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('0.1 NM', W - 20, H - 24);
  }, [boat, marks, rcBoat, pinEnd, toCanvas, pxPerNM]);

  return (
    <div className="relative w-full flex-1 flex flex-col">
      <canvas ref={canvasRef} width={380} height={380} className="w-full rounded-xl border border-slate-800" style={{ maxHeight: 380 }} />
      {/* Zoom controls */}
      <div className="absolute top-3 right-3 flex flex-col gap-1.5">
        <button onClick={() => setZoom(z => Math.min(z * 1.5, 20))}
          className="w-9 h-9 bg-slate-800/90 border border-slate-700 rounded-lg flex items-center justify-center text-white hover:bg-slate-700 active:scale-95 transition-all shadow">
          <Plus size={16} />
        </button>
        <button onClick={() => setZoom(z => Math.max(z / 1.5, 0.1))}
          className="w-9 h-9 bg-slate-800/90 border border-slate-700 rounded-lg flex items-center justify-center text-white hover:bg-slate-700 active:scale-95 transition-all shadow">
          <Minus size={16} />
        </button>
      </div>
      <div className="absolute bottom-3 left-3 text-[10px] font-mono text-slate-500 bg-slate-950/60 px-2 py-0.5 rounded">
        {(pxPerNM * 0.1).toFixed(0)} px = 0.1 NM · zoom ×{zoom.toFixed(1)}
      </div>
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// POLAR CHART (Tab 8) — SVG radar
// ══════════════════════════════════════════════════════════════════════════════
interface PolarChartProps { target: PolarTarget; samples: PolarSample[] }
const PolarChart = ({ target, samples }: PolarChartProps) => {
  const W = 300, H = 300, CX = 150, CY = 150, MAXR = 130;
  // Max SOG for radius scaling
  const maxSog = Math.max(target.upwindVmg * 1.5, ...samples.map(s => s.sog), 8);

  const polarToXY = (angleDeg: number, sog: number) => {
    const r = (sog / maxSog) * MAXR;
    const rad = toRad(angleDeg - 90);
    return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
  };

  // Build theoretical curve (0-180° both sides)
  const theoreticalPoints: string[] = [];
  for (let a = 0; a <= 180; a += 5) {
    // Simple interpolation between upwind and downwind target
    const fraction = Math.abs(a - target.upwindAngle) / Math.max(1, Math.abs(target.downwindAngle - target.upwindAngle));
    const sog = target.upwindVmg + (target.downwindVmg - target.upwindVmg) * Math.min(1, fraction);
    const p = polarToXY(a, Math.max(0, sog));
    theoreticalPoints.push(`${p.x},${p.y}`);
  }
  // Mirror (negative TWA = port tack)
  const theoreticalPointsMirror: string[] = [];
  for (let a = 0; a <= 180; a += 5) {
    const fraction = Math.abs(a - target.upwindAngle) / Math.max(1, Math.abs(target.downwindAngle - target.upwindAngle));
    const sog = target.upwindVmg + (target.downwindVmg - target.upwindVmg) * Math.min(1, fraction);
    const p = polarToXY(-a, Math.max(0, sog));
    theoreticalPointsMirror.push(`${p.x},${p.y}`);
  }

  const radii = [0.25, 0.5, 0.75, 1.0].map(f => f * MAXR);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 320 }}>
      {/* Concentric rings */}
      {radii.map((r, i) => (
        <g key={i}>
          <circle cx={CX} cy={CY} r={r} fill="none" stroke="#1e293b" strokeWidth="1" />
          <text x={CX + 3} y={CY - r + 4} fill="#475569" fontSize="8" fontFamily="monospace">
            {(maxSog * (i + 1) * 0.25).toFixed(1)}kt
          </text>
        </g>
      ))}
      {/* Angle lines every 30° */}
      {[0, 30, 60, 90, 120, 150, 180].map(a => {
        const p1 = polarToXY(a, 0); const p2 = polarToXY(a, maxSog);
        const pm1 = polarToXY(-a, 0); const pm2 = polarToXY(-a, maxSog);
        return (
          <g key={a}>
            <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#1e293b" strokeWidth="1" />
            {a > 0 && <line x1={pm1.x} y1={pm1.y} x2={pm2.x} y2={pm2.y} stroke="#1e293b" strokeWidth="1" />}
            <text x={p2.x + (a === 0 ? -5 : 3)} y={p2.y + 4} fill="#475569" fontSize="7" fontFamily="monospace">{a}°</text>
          </g>
        );
      })}
      {/* Theoretical starboard */}
      <polyline points={theoreticalPoints.join(' ')} fill="none" stroke="#22d3ee" strokeWidth="2" opacity="0.8" />
      {/* Theoretical port (mirror) */}
      <polyline points={theoreticalPointsMirror.join(' ')} fill="none" stroke="#22d3ee" strokeWidth="2" opacity="0.4" strokeDasharray="4,3" />
      {/* Actual samples scatter */}
      {samples.map((s, i) => {
        const p = polarToXY(Math.abs(s.twa), s.sog);
        const pm = polarToXY(-Math.abs(s.twa), s.sog);
        const col = s.sog > target.upwindVmg * 0.9 ? '#4ade80' : '#f87171';
        return (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="2.5" fill={col} opacity="0.7" />
            <circle cx={pm.x} cy={pm.y} r="2.5" fill={col} opacity="0.35" />
          </g>
        );
      })}
      {/* Target upwind/downwind marks */}
      {[{ a: target.upwindAngle, v: target.upwindVmg }, { a: target.downwindAngle, v: target.downwindVmg }].map(({ a, v }, i) => {
        const p = polarToXY(a, v); const pm = polarToXY(-a, v);
        return (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="5" fill="none" stroke="#22d3ee" strokeWidth="2" />
            <circle cx={pm.x} cy={pm.y} r="5" fill="none" stroke="#22d3ee" strokeWidth="1.5" opacity="0.5" />
          </g>
        );
      })}
      {/* Centre */}
      <circle cx={CX} cy={CY} r="3" fill="#475569" />
    </svg>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// POLARS TAB (proper component to allow useState at top level)
// ══════════════════════════════════════════════════════════════════════════════
interface PolarsTabProps {
  polarTarget: PolarTarget; polarSamples: PolarSample[];
  setPolarTarget: (t: PolarTarget) => void; setPolarSamples: (s: PolarSample[]) => void;
  calcVmg: number; boatData: BoatData;
}
const PolarsTab = ({ polarTarget, polarSamples, setPolarTarget, setPolarSamples, calcVmg, boatData }: PolarsTabProps) => {
  const [editTarget, setEditTarget] = useState(false);
  const [localTarget, setLocalTarget] = useState<PolarTarget>(polarTarget);
  const filteredSamples = polarSamples.filter(s => Math.abs(s.tws - polarTarget.tws) < 2.5);

  return (
    <div className="p-4 space-y-5 max-w-md mx-auto h-full overflow-y-auto pb-24">
      <h2 className="text-xl font-black text-white flex items-center gap-2"><BarChart2 className="text-pink-400 w-5 h-5" /> Polari & Performance</h2>
      <button onClick={() => setEditTarget(p => !p)}
        className="w-full flex items-center justify-between bg-slate-800 hover:bg-slate-700 border border-slate-700 px-4 py-3 rounded-xl text-sm font-bold text-slate-300 transition-colors">
        <span>⚙️ Setup Target Polari (TWS {polarTarget.tws} kt)</span>
        <ChevronDown size={16} className={`transition-transform ${editTarget ? 'rotate-180' : ''}`} />
      </button>
      {editTarget && (
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-4 space-y-4">
          {([
            { key: 'tws', label: 'TWS Riferimento (kt)', min: 5, max: 25, step: 1 },
            { key: 'upwindAngle', label: 'Angolo Bolina Target (°)', min: 30, max: 60, step: 1 },
            { key: 'upwindVmg', label: 'VMG Bolina Target (kt)', min: 2, max: 10, step: 0.1 },
            { key: 'downwindAngle', label: 'Angolo Poppa Target (°)', min: 100, max: 175, step: 1 },
            { key: 'downwindVmg', label: 'VMG Poppa Target (kt)', min: 2, max: 10, step: 0.1 },
          ] as { key: keyof PolarTarget; label: string; min: number; max: number; step: number }[]).map(({ key, label, min, max, step }) => (
            <div key={key}>
              <label className="block text-xs text-slate-400 font-semibold mb-1 uppercase">{label}</label>
              <div className="flex items-center gap-3">
                <input type="range" min={min} max={max} step={step}
                  value={localTarget[key] as number}
                  onChange={e => setLocalTarget(p => ({ ...p, [key]: parseFloat(e.target.value) }))}
                  className="flex-1 accent-pink-500" />
                <span className="text-white font-mono text-sm w-10 text-right">{(localTarget[key] as number).toFixed(String(key).includes('Vmg') ? 1 : 0)}</span>
              </div>
            </div>
          ))}
          <button onClick={() => { setPolarTarget(localTarget); setEditTarget(false); }}
            className="w-full bg-pink-600 hover:bg-pink-500 text-white py-2.5 rounded-xl font-bold shadow transition-all">Salva Target</button>
        </div>
      )}
      <div className="flex items-center justify-between bg-slate-800/60 px-4 py-2 rounded-xl border border-slate-700 text-xs font-mono">
        <span className="text-slate-400">Campioni</span>
        <span className="text-white font-bold">{polarSamples.length}</span>
        <span className="text-slate-500">~{polarTarget.tws}kt: {filteredSamples.length}</span>
        <button onClick={() => setPolarSamples([])} className="text-red-400 hover:text-red-300 text-[10px] ml-2">Reset</button>
      </div>
      <div className="bg-slate-900 rounded-2xl border border-slate-800 p-4">
        <div className="flex justify-between items-center mb-2">
          <span className="text-slate-400 text-[10px] font-bold uppercase">Curva Polare</span>
          <div className="flex gap-3 text-[9px] font-mono">
            <span className="flex items-center gap-1"><span className="w-3 h-1 bg-cyan-400 inline-block rounded" /> Target</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 bg-green-400 rounded-full inline-block" /> ✓</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 bg-red-400 rounded-full inline-block" /> ✗</span>
          </div>
        </div>
        <PolarChart target={polarTarget} samples={filteredSamples} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800 p-3 rounded-xl border border-slate-700">
          <div className="text-slate-500 text-[10px] uppercase">VMG Attuale</div>
          <div className={`text-2xl font-mono font-black ${calcVmg >= polarTarget.upwindVmg * 0.9 ? 'text-green-400' : 'text-red-400'}`}>{calcVmg.toFixed(2)} <span className="text-xs text-slate-500">kt</span></div>
          <div className="text-[10px] text-slate-500 mt-0.5">Target: {polarTarget.upwindVmg.toFixed(1)} kt</div>
        </div>
        <div className="bg-slate-800 p-3 rounded-xl border border-slate-700">
          <div className="text-slate-500 text-[10px] uppercase">TWA / SOG</div>
          <div className="text-xl font-mono font-black text-amber-400">{Math.abs(boatData.TWA).toFixed(0)}° / {boatData.SOG.toFixed(1)}</div>
          <div className="text-[10px] text-slate-500 mt-0.5">TWS: {boatData.TWS.toFixed(1)} kt</div>
        </div>
      </div>
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════════════════
const DEFAULT_POLAR: PolarTarget = { tws: 10, upwindAngle: 42, upwindVmg: 5.2, downwindAngle: 140, downwindVmg: 4.8 };

const Index = () => {
  const [activeTab, setActiveTab] = useState(0);
  const [simulatorActive, setSimulatorActive] = useState(false);
  const [showWifiPanel, setShowWifiPanel] = useState(false);
  const [wifiConfig, setWifiConfig] = useState<WifiConfig>({ host: '192.168.4.1', port: 2000, protocol: 'UDP' });

  const [boatData, setBoatData] = useState<BoatData>({
    HDG: 45, COG: 43, SOG: 6.5, STW: 0, AWS: 12.0, AWA: 35, TWS: 10.5, TWA: 42, TWD: 87,
    lat: RACE_AREA_CENTER.lat, lon: RACE_AREA_CENTER.lon,
    depth: 0, waterTemp: 0,
  });

  const [vmgSource, setVmgSource] = useState<'calc' | 'instr'>('calc');
  const [racePhase, setRacePhase] = useState<'first' | 'next'>('first');
  const [activeCourseId, setActiveCourseId] = useState<keyof typeof COURSES>('orc2');
  const [marks, setMarks] = useState<Record<string, MarkPos>>({});
  const [targetSequenceIdx, setTargetSequenceIdx] = useState(0);

  // Start line: two points
  const [rcBoat, setRcBoat] = useState<MarkPos | null>(null);     // Committee / Giuria (starboard)
  const [pinEnd, setPinEnd] = useState<MarkPos | null>(null);     // Pin end (port)

  const [refWind, setRefWind] = useState<number | null>(null);
  const [windHistory, setWindHistory] = useState<number[]>([]);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(300);
  const [countdownActive, setCountdownActive] = useState(false);

  // Polars
  const [polarTarget, setPolarTarget] = useState<PolarTarget>(DEFAULT_POLAR);
  const [polarSamples, setPolarSamples] = useState<PolarSample[]>([]);

  // ── NMEA PARSER ─────────────────────────────────────────────────────────────
  const parseNavData = useCallback((input: string | object) => {
    try {
      // Strip checksum if present: "$IIVHW,,,,,4.6,N,,*2B" → "$IIVHW,,,,,4.6,N,,"
      const stripChecksum = (s: string) => {
        const idx = s.indexOf('*');
        return idx > 0 ? s.substring(0, idx) : s;
      };

      if (typeof input === 'string' && input.startsWith('$')) {
        const clean = stripChecksum(input.trim());
        const parts = clean.split(',');
        const hdr = parts[0];

        setBoatData(prev => {
          const nd = { ...prev };

          // ── HEADING ──
          if (hdr === '$HEHDT') {
            // True heading
            const h = parseFloat(parts[1]);
            if (!isNaN(h)) nd.HDG = h;
          }

          // ── VHW — Speed Through Water + optional heading ──
          // Format: $IIVHW,HDG_T,T,HDG_M,M,STW_KT,N,STW_KMH,K
          else if (hdr === '$IIVHW') {
            const hdgTrue = parseFloat(parts[1]);
            const hdgMag = parseFloat(parts[3]);
            const stw = parseFloat(parts[5]); // Speed through water in knots
            if (!isNaN(hdgTrue)) nd.HDG = hdgTrue;
            else if (!isNaN(hdgMag)) nd.HDG = hdgMag;
            if (!isNaN(stw)) nd.STW = stw;
            // Use STW as fallback SOG if no VTG/RMC
            if (!isNaN(stw) && stw > 0) nd.SOG = stw;
          }

          // ── VTG — Track made good and Ground speed ──
          else if (hdr === '$GPVTG' || hdr === '$IIVTG') {
            const cog = parseFloat(parts[1]);
            const sogKt = parseFloat(parts[5]);
            if (!isNaN(cog)) nd.COG = cog;
            if (!isNaN(sogKt)) nd.SOG = sogKt;
          }

          // ── RMC — Position, SOG, COG ──
          else if (hdr === '$GPRMC' || hdr === '$IIRMC') {
            if (parts[2] === 'A') {
              const sog = parseFloat(parts[7]);
              const cog = parseFloat(parts[8]);
              if (!isNaN(sog)) nd.SOG = sog;
              if (!isNaN(cog)) nd.COG = cog;
              const rawLat = parseFloat(parts[3]), rawLon = parseFloat(parts[5]);
              if (!isNaN(rawLat) && !isNaN(rawLon)) {
                nd.lat = (parts[4] === 'S' ? -1 : 1) * (Math.floor(rawLat / 100) + (rawLat % 100) / 60);
                nd.lon = (parts[6] === 'W' ? -1 : 1) * (Math.floor(rawLon / 100) + (rawLon % 100) / 60);
              }
            }
          }

          // ── GLL — Geographic Position ──
          else if (hdr === '$GPGLL' || hdr === '$IIGLL') {
            const rawLat = parseFloat(parts[1]), rawLon = parseFloat(parts[3]);
            if (!isNaN(rawLat) && !isNaN(rawLon)) {
              nd.lat = (parts[2] === 'S' ? -1 : 1) * (Math.floor(rawLat / 100) + (rawLat % 100) / 60);
              nd.lon = (parts[4] === 'W' ? -1 : 1) * (Math.floor(rawLon / 100) + (rawLon % 100) / 60);
            }
          }

          // ── MWV — Wind Speed and Angle (Apparent or True) ──
          // Format: $WIMWV,angle,R/T,speed,N,A
          else if (hdr === '$IIMWV' || hdr === '$WIMWV') {
            const angle = parseFloat(parts[1]);
            const ref = parts[2]; // R=Relative (apparent), T=True
            const speed = parseFloat(parts[3]);
            if (!isNaN(angle) && !isNaN(speed)) {
              // Normalize to ±180: 312° → -48° (port), 45° → +45° (starboard)
              const norm = angle > 180 ? angle - 360 : angle;
              if (ref === 'R') {
                nd.AWA = norm;
                nd.AWS = speed;
                // Compute TWD from HDG + AWA when no MWD sentence is available
                nd.TWD = (nd.HDG + norm + 360) % 360;
              } else {
                nd.TWA = norm;
                nd.TWS = speed;
              }
            }
          }

          // ── MWD — Wind Direction & Speed (True) ──
          else if (hdr === '$IIMWD' || hdr === '$WIMWD') {
            const twd = parseFloat(parts[1]);
            const tws = parseFloat(parts[5]);
            if (!isNaN(twd)) nd.TWD = twd;
            if (!isNaN(tws)) nd.TWS = tws;
          }

          // ── DBT — Depth Below Transducer ──
          // $IIDBT,26.50,f,8.08,M,,F
          else if (hdr === '$IIDBT') {
            const depthM = parseFloat(parts[3]); // meters
            if (!isNaN(depthM)) nd.depth = depthM;
          }

          // ── MTW — Mean Temperature of Water ──
          // $IIMTW,16.3,C
          else if (hdr === '$IIMTW') {
            const temp = parseFloat(parts[1]);
            if (!isNaN(temp)) nd.waterTemp = temp;
          }

          // ── VLW — Distance Traveled through Water ──
          // $IIVLW,141.1,N,141.17,N — logged but not stored yet

          // Compute derived TWA if we have TWD and HDG but TWA wasn't set directly
          if (nd.TWD !== prev.TWD || nd.HDG !== prev.HDG) {
            let twa = nd.TWD - nd.HDG;
            if (twa > 180) twa -= 360;
            if (twa < -180) twa += 360;
            nd.TWA = twa;
          }

          return nd;
        });
      } else if (typeof input === 'object' && input !== null) {
        const obj = input as Record<string, unknown>;
        setBoatData(prev => {
          const nd = { ...prev };
          switch (obj.pgn) {
            case 127250: if (obj.heading !== undefined) nd.HDG = obj.heading as number; break;
            case 129026: if (obj.cog !== undefined) nd.COG = obj.cog as number; if (obj.sog !== undefined) nd.SOG = obj.sog as number; break;
            case 129025: if (obj.latitude !== undefined) nd.lat = obj.latitude as number; if (obj.longitude !== undefined) nd.lon = obj.longitude as number; break;
            case 130306: {
              const wa = obj.windAngle as number;
              const angle = wa > 180 ? wa - 360 : wa;
              if (obj.reference === 'Apparent') { nd.AWA = angle; nd.AWS = obj.windSpeed as number; }
              else { nd.TWA = angle; nd.TWS = obj.windSpeed as number; }
              break;
            }
          }
          return nd;
        });
      } else if (typeof input === 'string') {
        try { parseNavData(JSON.parse(input)); } catch { /* not JSON */ }
      }
    } catch (e) { console.error('NMEA parse error', e); }
  }, []);

  const { status: wifiStatus, errorMsg: wifiError, connect: wifiConnect, disconnect: wifiDisconnect, bytesReceived, messagesReceived, packets: wifiPackets, clearPackets: wifiClearPackets } = useWifiConnection(parseNavData);
  const isWifiOn = wifiStatus === 'connected';
  const isWifiConnecting = wifiStatus === 'connecting';

  // ── SIMULATOR ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!simulatorActive) return;
    let t = 0;
    const id = setInterval(() => {
      t += 0.5;
      setBoatData(prev => {
        const hdgNoise = (Math.random() - 0.5) * 3;
        const spdNoise = (Math.random() - 0.5) * 0.3;
        const windNoise = (Math.random() - 0.5) * 4;
        const newHDG = (prev.HDG + hdgNoise + 360) % 360;
        const newTWD = (87 + windNoise * Math.sin(t * 0.05) + 360) % 360;
        let newTWA = newTWD - newHDG; if (newTWA > 180) newTWA -= 360; if (newTWA < -180) newTWA += 360;
        const bs = Math.max(0, prev.SOG + spdNoise);
        const twaRad = toRad(Math.abs(newTWA));
        const twsKts = prev.TWS;
        const awsX = twsKts * Math.sin(twaRad);
        const awsY = twsKts * Math.cos(twaRad) + bs;
        const newAWS = Math.sqrt(awsX * awsX + awsY * awsY);
        const newAWA = toDeg(Math.atan2(awsX, awsY)) * Math.sign(newTWA || 1);
        const distNM = bs / 3600;
        const newLat = prev.lat + (distNM * Math.cos(toRad(prev.COG))) / 60;
        const newLon = prev.lon + (distNM * Math.sin(toRad(prev.COG))) / (60 * Math.cos(toRad(prev.lat)));
        if (Math.random() > 0.75) setWindHistory(h => { const n = [...h, newTWD]; if (n.length > 24) n.shift(); return n; });
        return { ...prev, HDG: newHDG, COG: (newHDG - 2 + 360) % 360, SOG: bs, TWA: newTWA, TWD: newTWD, TWS: prev.TWS + (Math.random() - 0.5) * 0.05, AWA: newAWA, AWS: newAWS, lat: newLat, lon: newLon };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [simulatorActive]);

  // ── POLAR LOGGER (WiFi only — no simulation data) ────────────────────────────
  useEffect(() => {
    if (!isWifiOn) return;
    const id = setInterval(() => {
      setBoatData(bd => {
        if (bd.SOG > 0.5 && Math.abs(bd.TWA) > 5) {
          setPolarSamples(s => {
            const n = [...s, { tws: bd.TWS, twa: bd.TWA, sog: bd.SOG }];
            if (n.length > 300) n.shift();
            return n;
          });
        }
        return bd;
      });
    }, 5000);
    return () => clearInterval(id);
  }, [isWifiOn]);

  // ── TIMER RRS 26 ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!countdownActive) return;
    const id = setInterval(() => setCountdown(p => p - 1), 1000);
    return () => clearInterval(id);
  }, [countdownActive]);

  const syncTimer = (minutes: number) => { setCountdown(minutes * 60); setCountdownActive(true); };

  // ── HELPERS ──────────────────────────────────────────────────────────────────
  const activeCourse = COURSES[activeCourseId];
  const targetId = activeCourse.sequence[targetSequenceIdx];
  const targetMark = marks[targetId] ?? null;
  const targetBearing = targetMark ? calcBearing(boatData.lat, boatData.lon, targetMark.lat, targetMark.lon) : null;

  const pingMark = (id: string) => setMarks(p => ({ ...p, [id]: { lat: boatData.lat, lon: boatData.lon } }));
  const clearMarks = () => { setMarks({}); setRcBoat(null); setPinEnd(null); };
  const advanceTarget = () => { if (targetSequenceIdx < activeCourse.sequence.length - 1) setTargetSequenceIdx(i => i + 1); };

  const calcVmg = boatData.SOG * Math.cos(toRad(Math.abs(boatData.TWA)));
  const displayVmg = vmgSource === 'calc' ? calcVmg : boatData.SOG * 0.9;

  let vmc: number | null = null, dtw: number | null = null, ttaSec: number | null = null;
  if (racePhase === 'next' && targetMark) {
    dtw = calcDistance(boatData.lat, boatData.lon, targetMark.lat, targetMark.lon);
    const brg = calcBearing(boatData.lat, boatData.lon, targetMark.lat, targetMark.lon);
    const relBrg = angleDiff(brg, boatData.COG);
    vmc = boatData.SOG * Math.cos(toRad(relBrg));
    if (vmc > 0.1) ttaSec = (dtw / vmc) * 3600;
  }

  const generateAI = () => {
    let s = '';
    const isUpwind = Math.abs(boatData.TWA) < 90;
    const tack = boatData.TWA > 0 ? 'Dritta' : 'Sinistra';
    if (refWind !== null) {
      let shift = boatData.TWD - refWind;
      if (shift > 180) shift -= 360; if (shift < -180) shift += 360;
      if (Math.abs(shift) > 5) {
        const isLift = (tack === 'Dritta' && shift < 0) || (tack === 'Sinistra' && shift > 0);
        s += `Vento ruotato ${Math.abs(shift).toFixed(0)}° a ${shift > 0 ? 'Destra' : 'Sinistra'} — ${isLift ? '✅ Lift' : '⚠️ Header'}. `;
        if (!isLift && isUpwind) s += 'Valuta la virata. ';
      } else { s += 'Vento stabile rispetto al riferimento. '; }
    }
    if (boatData.SOG < 3.5) s += '⚡ SOG critica: poggia 5-10° per recuperare velocità. ';
    if (racePhase === 'next' && targetMark && targetBearing !== null) {
      const err = Math.abs(angleDiff(targetBearing, boatData.COG));
      s += err > 15 ? `🎯 Fuori rotta di ${err.toFixed(0)}° verso ${targetId} (punta ${targetBearing.toFixed(0)}°). ` : `✅ Rotta ottima verso ${targetId}. `;
    }
    if (isUpwind && Math.abs(calcVmg) < boatData.SOG * 0.55) s += '🔼 Orzare per migliorare VMG. ';
    if (!s) s = '✅ Condizioni stabili. Massimizza VMG e mantieni la regolazione.';
    setAiSuggestion(s);
  };

  // ════════════════════════════════════════════════════════════════════════════
  // TAB 0 — DASHBOARD
  // ════════════════════════════════════════════════════════════════════════════
  const renderDashboard = () => (
    <div className="flex flex-col items-center p-4 space-y-4 h-full overflow-y-auto pb-24">
      <div className="flex justify-between w-full max-w-md bg-slate-800 p-2.5 rounded-xl border border-slate-700">
        <div className="flex flex-col w-1/2 items-center">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Fase Regata</span>
          <button onClick={() => setRacePhase(p => p === 'first' ? 'next' : 'first')}
            className={`mt-1 px-3 py-1.5 rounded-lg text-xs font-bold shadow transition-colors ${racePhase === 'first' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'}`}>
            {racePhase === 'first' ? '1° GIRO — VMG' : 'GIRI SUCC. — VMC'}
          </button>
        </div>
        <div className="flex flex-col w-1/2 items-center border-l border-slate-700">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Target Mark</span>
          <div className="flex items-center gap-2 mt-0.5">
            <div className="text-xl font-black text-amber-400">{targetId}</div>
            {targetSequenceIdx < activeCourse.sequence.length - 1 && (
              <button onClick={advanceTarget} className="text-[9px] bg-green-700/60 hover:bg-green-600 text-green-300 px-2 py-0.5 rounded font-bold">NEXT →</button>
            )}
          </div>
        </div>
      </div>

      {/* 360° Compass — prominent display */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 shadow-2xl relative overflow-hidden w-full max-w-md">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.06)_0,transparent_70%)] pointer-events-none" />
        <div className="flex justify-between w-full text-[10px] font-mono mb-1 px-1">
          <span className="text-cyan-400 flex items-center gap-1"><Wind size={10} /> AWA</span>
          <span className="text-amber-400 flex items-center gap-1"><Wind size={10} /> TWA</span>
          <span className="text-purple-400">COG ––</span>
          {targetBearing !== null && <span className="text-red-400">● {targetId}</span>}
        </div>
        <CompassDisplay boat={boatData} targetBearing={targetBearing} racePhase={racePhase} targetId={targetId} />
      </div>

      {/* Data grid */}
      <div className="grid grid-cols-2 gap-3 w-full max-w-md">
        <div className="bg-slate-800 p-3 rounded-xl border-l-4 border-white flex flex-col items-center">
          <span className="text-slate-400 text-[10px] font-bold uppercase">SOG / STW</span>
          <span className="text-3xl font-mono text-white font-bold">{boatData.SOG.toFixed(1)}</span>
          <span className="text-slate-500 text-[9px]">kt {boatData.STW > 0 ? `· STW ${boatData.STW.toFixed(1)}` : ''}</span>
        </div>
        <div className="bg-slate-800 p-3 rounded-xl border-l-4 border-purple-500 flex flex-col items-center">
          <span className="text-slate-400 text-[10px] font-bold uppercase">COG</span>
          <span className="text-3xl font-mono text-purple-400 font-bold">{boatData.COG.toFixed(0)}</span>
          <span className="text-slate-500 text-[9px]">°T</span>
        </div>
        <div className="bg-slate-800 p-3 rounded-xl border-l-4 border-amber-500 flex flex-col items-center">
          <span className="text-slate-400 text-[10px] font-bold uppercase">TWS / TWA</span>
          <span className="text-xl font-mono text-amber-400 font-bold">{boatData.TWS.toFixed(1)} <span className="text-slate-600">|</span> {Math.abs(boatData.TWA).toFixed(0)}</span>
          <span className="text-slate-500 text-[9px]">kt / ° {boatData.TWA >= 0 ? 'S' : 'P'}</span>
        </div>
        <div className="bg-slate-800 p-3 rounded-xl border-l-4 border-cyan-400 flex flex-col items-center">
          <span className="text-slate-400 text-[10px] font-bold uppercase">AWS / AWA</span>
          <span className="text-xl font-mono text-cyan-400 font-bold">{boatData.AWS.toFixed(1)} <span className="text-slate-600">|</span> {Math.abs(boatData.AWA).toFixed(0)}</span>
          <span className="text-slate-500 text-[9px]">kt / ° {boatData.AWA >= 0 ? 'S' : 'P'}</span>
        </div>

        {/* Depth & Water Temp (only show if data available) */}
        {(boatData.depth > 0 || boatData.waterTemp > 0) && (
          <>
            {boatData.depth > 0 && (
              <div className="bg-slate-800 p-3 rounded-xl border-l-4 border-teal-500 flex flex-col items-center">
                <span className="text-slate-400 text-[10px] font-bold uppercase">Fondale</span>
                <span className="text-xl font-mono text-teal-400 font-bold">{boatData.depth.toFixed(1)}</span>
                <span className="text-slate-500 text-[9px]">m</span>
              </div>
            )}
            {boatData.waterTemp > 0 && (
              <div className="bg-slate-800 p-3 rounded-xl border-l-4 border-sky-400 flex flex-col items-center">
                <span className="text-slate-400 text-[10px] font-bold uppercase">Temp. Acqua</span>
                <span className="text-xl font-mono text-sky-400 font-bold">{boatData.waterTemp.toFixed(1)}</span>
                <span className="text-slate-500 text-[9px]">°C</span>
              </div>
            )}
          </>
        )}

        <div className="col-span-2 bg-gradient-to-br from-slate-800 to-slate-900 p-4 rounded-xl border border-slate-700">
          <div className="flex justify-between items-center mb-2">
            <span className="text-slate-400 text-[10px] font-bold uppercase">{racePhase === 'first' ? 'VMG Performance' : `VMC → ${targetId}`}</span>
            {racePhase === 'first' && (
              <button onClick={() => setVmgSource(s => s === 'calc' ? 'instr' : 'calc')}
                className="text-[9px] bg-slate-700 text-slate-300 px-2 py-0.5 rounded uppercase border border-slate-600">
                {vmgSource === 'calc' ? 'Calcolato' : 'Strumento'}
              </button>
            )}
          </div>
          {racePhase === 'first' ? (
            <div className="flex justify-between items-end">
              <div>
                <div className="text-slate-500 text-xs">{Math.abs(boatData.TWA) < 90 ? '▲ Upwind' : '▼ Downwind'}</div>
                <span className="text-4xl font-mono font-black text-green-400">{Math.abs(displayVmg).toFixed(2)}</span>
                <span className="text-slate-500 text-xs ml-1">kt</span>
              </div>
              <div className="text-right text-xs text-slate-500"><div>TWD {boatData.TWD.toFixed(0)}°</div><div>HDG {boatData.HDG.toFixed(0)}°</div></div>
            </div>
          ) : (
            <div className="flex justify-between items-end">
              <div>
                <span className={`text-3xl font-mono font-black ${vmc !== null && vmc > 0 ? 'text-green-400' : 'text-red-500'}`}>{vmc !== null ? vmc.toFixed(2) : '--.--'}</span>
                <span className="text-slate-500 text-xs ml-1">kt</span>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-slate-500 text-[10px] uppercase">DTW / ETA</span>
                <span className="text-base font-mono font-bold text-white">{dtw !== null ? `${(dtw * 1852).toFixed(0)} m` : '---'}</span>
                <span className="text-xs font-mono text-amber-400">{formatTime(ttaSec)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // ════════════════════════════════════════════════════════════════════════════
  // TAB 1 — COURSE
  // ════════════════════════════════════════════════════════════════════════════
  const renderCourse = () => (
    <div className="p-4 space-y-5 max-w-md mx-auto h-full overflow-y-auto pb-24">
      <div>
        <h2 className="text-xl font-black text-white mb-1 flex items-center gap-2"><Route className="text-blue-500 w-5 h-5" /> Ravenna Yacht Club</h2>
        <p className="text-slate-400 text-xs">43° Camp. Invernale — Istruzioni di Regata</p>
        <p className="text-slate-500 text-[10px] mt-0.5">Campo B: 44°28'12"N 012°19'03"E · VHF ch.72</p>
      </div>
      <div className="space-y-3">
        {Object.entries(COURSES).map(([id, c]) => (
          <label key={id} className={`flex items-start p-3.5 rounded-xl cursor-pointer border-2 transition-all ${activeCourseId === id ? 'bg-slate-800 border-blue-500' : 'bg-slate-900 border-slate-800 hover:border-slate-600'}`}>
            <input type="radio" name="course" value={id} checked={activeCourseId === id}
              onChange={() => { setActiveCourseId(id as keyof typeof COURSES); setTargetSequenceIdx(0); }}
              className="mt-1 w-4 h-4 accent-blue-500" />
            <div className="ml-3 flex-1">
              <div className="flex items-center justify-between">
                <div className="font-bold text-white text-base">{c.name}</div>
                <span className="text-[9px] text-slate-500 font-mono">{c.signal}</span>
              </div>
              <div className="text-xs text-slate-400 mt-1 mb-1.5 font-mono">{c.sequence.join(' → ')}</div>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${c.color === 'yellow' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-orange-500/20 text-orange-400'}`}>{c.label}</span>
            </div>
          </label>
        ))}
      </div>
      <div className="bg-slate-800 p-4 rounded-xl border border-slate-700">
        <h3 className="text-slate-400 font-bold uppercase text-[10px] mb-3">Navigazione Attiva</h3>
        <div className="flex flex-wrap gap-2 items-center">
          {activeCourse.sequence.map((mark, idx) => (
            <React.Fragment key={`${mark}-${idx}`}>
              <div onClick={() => setTargetSequenceIdx(idx)}
                className={`flex items-center justify-center w-10 h-10 rounded-full font-black text-xs cursor-pointer transition-all
                  ${idx === targetSequenceIdx ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.8)] border-2 border-white scale-110'
                    : idx < targetSequenceIdx ? 'bg-green-700/30 text-green-400 border border-green-700/50'
                      : 'bg-slate-700 text-slate-400 border border-slate-600'}`}>{mark}</div>
              {idx < activeCourse.sequence.length - 1 && <div className="text-slate-600 text-xs">›</div>}
            </React.Fragment>
          ))}
        </div>
        <p className="text-[10px] text-slate-600 mt-3 text-center">Tocca una boa per impostare il target manualmente.</p>
      </div>
    </div>
  );

  // ════════════════════════════════════════════════════════════════════════════
  // TAB 2 — PING BOES
  // ════════════════════════════════════════════════════════════════════════════
  const renderPing = () => (
    <div className="p-4 flex flex-col h-full overflow-y-auto pb-24 max-w-md mx-auto">
      <div className="flex justify-between items-center mb-5">
        <div>
          <h2 className="text-xl font-black text-white flex items-center gap-2"><MapPin className="text-red-500 w-5 h-5" /> Acquisizione Boe</h2>
          <p className="text-slate-400 text-xs">Ping posizione GPS attuale</p>
        </div>
        <button onClick={clearMarks} className="flex items-center gap-1 bg-red-900/50 hover:bg-red-800 text-red-400 px-3 py-2 rounded-lg font-bold text-xs transition-colors"><Trash2 size={14} /> Reset</button>
      </div>
      {/* Start line buoys (RC Boat + Pin End) */}
      <div className="mb-4">
        <h3 className="text-slate-300 font-bold text-sm flex items-center gap-2 mb-2"><Flag size={14} className="text-red-400" /> Linea di Partenza</h3>
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => setPinEnd({ lat: boatData.lat, lon: boatData.lon })}
            className={`relative flex flex-col items-center justify-center rounded-2xl border-4 py-4 transition-all active:scale-95
              ${pinEnd ? 'bg-rose-900/40 border-rose-500 shadow-[0_0_15px_rgba(244,63,94,0.25)]' : 'bg-slate-800 border-slate-700 hover:border-rose-700'}`}>
            <span className="text-2xl mb-1">🔴</span>
            <span className="text-white font-black text-sm">Boa Pin</span>
            <span className="text-[10px] text-slate-400">Sinistra</span>
            {pinEnd && <span className="absolute bottom-1.5 text-[9px] text-rose-400 font-mono">✓ Acquisita</span>}
          </button>
          <button onClick={() => setRcBoat({ lat: boatData.lat, lon: boatData.lon })}
            className={`relative flex flex-col items-center justify-center rounded-2xl border-4 py-4 transition-all active:scale-95
              ${rcBoat ? 'bg-green-900/40 border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.25)]' : 'bg-slate-800 border-slate-700 hover:border-green-700'}`}>
            <span className="text-2xl mb-1">🟢</span>
            <span className="text-white font-black text-sm">Barca Giuria</span>
            <span className="text-[10px] text-slate-400">Dritta</span>
            {rcBoat && <span className="absolute bottom-1.5 text-[9px] text-green-400 font-mono">✓ Acquisita</span>}
          </button>
        </div>
      </div>

      {/* Course marks */}
      <div className="grid grid-cols-3 gap-3 flex-grow">
        {ALL_MARKS.map(mark => {
          const acquired = !!marks[mark];
          const isTarget = mark === targetId && racePhase === 'next';
          return (
            <button key={mark} onClick={() => pingMark(mark)}
              className={`relative flex flex-col items-center justify-center rounded-2xl border-4 transition-all active:scale-95 min-h-[90px]
                ${acquired ? isTarget ? 'bg-blue-900/40 border-blue-400 shadow-[0_0_20px_rgba(96,165,250,0.3)]' : 'bg-green-900/40 border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.2)]' : 'bg-slate-800 border-slate-700 hover:border-slate-500'}`}>
              <span className={`text-3xl font-black ${acquired ? 'text-white' : 'text-slate-400'}`}>{mark}</span>
              {acquired && <span className="absolute bottom-2 text-[9px] text-green-400 font-mono font-bold">✓ Acquisita</span>}
              {isTarget && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-blue-400 animate-pulse" />}
            </button>
          );
        })}
      </div>
      <div className="mt-5 bg-slate-900 p-3 rounded-xl border border-slate-800">
        <h3 className="text-slate-400 text-[10px] font-bold uppercase mb-1.5">Posizione GPS</h3>
        <div className="flex justify-between font-mono text-xs text-white">
          <span>Lat: {boatData.lat.toFixed(5)}° N</span>
          <span>Lon: {boatData.lon.toFixed(5)}° E</span>
        </div>
      </div>
    </div>
  );

  // ════════════════════════════════════════════════════════════════════════════
  // TAB 3 — WIND
  // ════════════════════════════════════════════════════════════════════════════
  const renderWind = () => {
    let shift: number | null = null, isHeader = false, isLift = false;
    if (refWind !== null) {
      shift = boatData.TWD - refWind;
      if (shift > 180) shift -= 360; if (shift < -180) shift += 360;
      const tack = boatData.TWA > 0 ? 'dritta' : 'sinistra';
      if (Math.abs(shift) > 2) {
        isHeader = (tack === 'dritta' && shift > 0) || (tack === 'sinistra' && shift < 0);
        isLift = !isHeader;
      }
    }
    return (
      <div className="p-4 space-y-5 max-w-md mx-auto h-full overflow-y-auto pb-24">
        <h2 className="text-xl font-black text-white flex items-center gap-2"><Wind className="text-cyan-400 w-5 h-5" /> Analisi Vento Reale</h2>
        <div className="bg-slate-800 p-5 rounded-2xl border border-slate-700 flex flex-col items-center">
          <span className="text-slate-400 text-xs font-bold uppercase mb-1">TWD Attuale</span>
          <span className="text-6xl font-black text-amber-400 font-mono">{boatData.TWD.toFixed(0)}°</span>
          <div className="grid grid-cols-2 gap-3 mt-4 w-full">
            <div className="text-center"><div className="text-slate-500 text-[10px] uppercase">TWS</div><div className="text-2xl font-bold text-amber-300 font-mono">{boatData.TWS.toFixed(1)} kt</div></div>
            <div className="text-center"><div className="text-slate-500 text-[10px] uppercase">TWA</div><div className="text-2xl font-bold text-amber-300 font-mono">{Math.abs(boatData.TWA).toFixed(0)}° {boatData.TWA >= 0 ? 'S' : 'P'}</div></div>
          </div>
          <button onClick={() => setRefWind(boatData.TWD)} className="mt-5 bg-cyan-700 hover:bg-cyan-600 text-white w-full py-3 rounded-xl font-bold text-sm shadow-lg active:scale-95 transition-all">📌 Imposta Vento Riferimento</button>
          {refWind !== null && <div className="mt-3 text-slate-400 font-mono text-xs">Riferimento: <span className="font-bold text-white">{refWind.toFixed(0)}°</span></div>}
        </div>
        {refWind !== null && shift !== null && (
          <div className={`p-5 rounded-2xl border-2 flex flex-col items-center text-center ${Math.abs(shift) <= 2 ? 'bg-slate-800 border-slate-600' : isHeader ? 'bg-red-900/30 border-red-500' : 'bg-green-900/30 border-green-500'}`}>
            <span className="text-slate-400 font-bold uppercase text-[10px] mb-1">Variazione Vento</span>
            <div className="text-5xl font-black text-white font-mono mb-2">{shift > 0 ? '+' : ''}{shift.toFixed(0)}°</div>
            <div className="text-base font-bold">
              {Math.abs(shift) <= 2 ? <span className="text-slate-300">Vento Stabile</span> : (
                <><span className="text-white">Rotazione {shift > 0 ? 'Destra' : 'Sinistra'}</span><br />
                  <span className={`text-xl uppercase ${isHeader ? 'text-red-400' : 'text-green-400'}`}>{isHeader ? '⚠️ Scarso (Header)' : '✅ Buono (Lift)'}</span></>
              )}
            </div>
            <div className="text-[10px] text-slate-500 mt-2 uppercase">Mure: {boatData.TWA > 0 ? 'Dritta' : 'Sinistra'}</div>
          </div>
        )}
        <div className="bg-slate-900 p-4 rounded-xl border border-slate-800">
          <div className="text-slate-500 text-[10px] font-bold uppercase mb-2">Trend TWD (ultimi {windHistory.length} campioni)</div>
          <div className="h-32 flex items-end gap-0.5 overflow-hidden">
            {windHistory.length === 0 ? <div className="w-full text-center text-slate-600 text-xs my-auto">Attendi raccolta dati...</div>
              : windHistory.map((val, i) => {
                const min = Math.min(...windHistory) - 3, max = Math.max(...windHistory) + 3;
                const hPct = Math.max(8, ((val - min) / (max - min)) * 100);
                const diff = refWind !== null ? val - refWind : 0;
                const col = refWind !== null && Math.abs(diff) > 2 ? diff > 0 ? 'bg-red-500' : 'bg-green-500' : 'bg-slate-600';
                return <div key={i} className={`flex-1 ${col} rounded-t-sm opacity-80`} style={{ height: `${hPct}%` }} />;
              })}
          </div>
        </div>
      </div>
    );
  };

  // ════════════════════════════════════════════════════════════════════════════
  // TAB 4 — AI
  // ════════════════════════════════════════════════════════════════════════════
  const renderAI = () => (
    <div className="p-4 space-y-5 max-w-md mx-auto h-full overflow-y-auto pb-24">
      <h2 className="text-xl font-black text-white flex items-center gap-2"><Brain className="text-purple-400 w-5 h-5" /> Assistente Tattico</h2>
      <button onClick={generateAI} className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white py-5 rounded-2xl font-black text-lg shadow-[0_0_30px_rgba(147,51,234,0.3)] active:scale-95 transition-all flex flex-col items-center gap-2">
        <Crosshair size={28} /> Genera Analisi Tattica
      </button>
      {aiSuggestion && (
        <div className="bg-slate-800 p-5 rounded-2xl border-l-4 border-purple-500 shadow-xl">
          <div className="text-purple-400 font-bold uppercase text-[10px] mb-2 flex items-center gap-1.5"><Settings2 size={12} /> Analisi</div>
          <p className="text-white text-base leading-relaxed">{aiSuggestion}</p>
        </div>
      )}
      <div className="bg-slate-900 p-4 rounded-xl border border-slate-800">
        <h3 className="text-slate-500 text-[10px] font-bold uppercase mb-2">Parametri correnti</h3>
        <ul className="text-slate-400 text-xs space-y-1 font-mono">
          <li>Mure: <span className="text-white">{boatData.TWA > 0 ? 'Dritta' : 'Sinistra'}</span></li>
          <li>TWD: <span className="text-white">{boatData.TWD.toFixed(0)}°</span></li>
          <li>TWS: <span className="text-white">{boatData.TWS.toFixed(1)} kt</span></li>
          <li>SOG: <span className="text-white">{boatData.SOG.toFixed(1)} kt</span></li>
          <li>VMG: <span className="text-green-400">{calcVmg.toFixed(2)} kt</span></li>
          <li>Target: <span className="text-amber-400">{targetId}</span></li>
          <li>Ref. vento: <span className="text-white">{refWind !== null ? `${refWind.toFixed(0)}°` : '—'}</span></li>
        </ul>
      </div>
    </div>
  );

  // ════════════════════════════════════════════════════════════════════════════
  // TAB 5 — START (2-point line, TTL, Line Bias)
  // ════════════════════════════════════════════════════════════════════════════
  const renderStart = () => {
    // Orthogonal projection of boat onto start line
    let ttlSec: number | null = null;
    let timeDelta: number | null = null;
    let distToLineProjM: number | null = null;
    let lineBiasLabel: string | null = null;
    let lineBiasDir: 'rc' | 'pin' | 'square' | null = null;

    if (rcBoat && pinEnd) {
      const proj = projectPointOnSegment(boatData.lat, boatData.lon, rcBoat.lat, rcBoat.lon, pinEnd.lat, pinEnd.lon);
      distToLineProjM = proj.distNM * 1852;

      // TTL: use VMC toward projected point on line
      if (boatData.SOG > 0.3) {
        const brgToProj = calcBearing(boatData.lat, boatData.lon, proj.projLat, proj.projLon);
        const relBrg = angleDiff(brgToProj, boatData.COG);
        const vmcLine = boatData.SOG * Math.cos(toRad(relBrg));
        if (vmcLine > 0.05) ttlSec = (proj.distNM / vmcLine) * 3600;
      }
      if (ttlSec !== null) timeDelta = countdown - ttlSec;

      // Line Bias: compare TWD vs line orthogonal bearing
      const lineBrg = calcBearing(rcBoat.lat, rcBoat.lon, pinEnd.lat, pinEnd.lon); // RC → Pin
      const lineOrthogonal = (lineBrg + 90) % 360; // upwind perpendicular
      let biasAngle = angleDiff(boatData.TWD, lineOrthogonal);
      if (Math.abs(biasAngle) < 3) { lineBiasDir = 'square'; lineBiasLabel = '⬜ Linea Quadra'; }
      else if (biasAngle > 0) { lineBiasDir = 'rc'; lineBiasLabel = '🟢 Vantaggio Barca Giuria'; }
      else { lineBiasDir = 'pin'; lineBiasLabel = '🔴 Vantaggio Boa (Pin)'; }
    }

    return (
      <div className="p-4 space-y-4 max-w-md mx-auto h-full overflow-y-auto pb-24">
        <h2 className="text-xl font-black text-white flex items-center gap-2"><Flag className="text-red-500 w-5 h-5" /> Start Regata</h2>
        <p className="text-[10px] text-slate-500">Procedura RRS 26 · VHF ch.72 · Avviso 10:25</p>

        {/* TIMER */}
        <div className="bg-slate-800 p-5 rounded-3xl border-2 border-slate-700 flex flex-col items-center shadow-2xl">
          <div className="text-slate-400 font-bold uppercase tracking-widest text-xs mb-1">Timer Partenza</div>
          <div className={`text-7xl font-black font-mono tracking-tighter ${countdown <= 0 ? 'text-red-500' : countdown <= 60 ? 'text-amber-400' : 'text-white'}`}>{formatTime(countdown)}</div>
          <div className="flex gap-2 mt-2 text-[9px] font-mono">
            {[{ t: 300, l: 'Avviso' }, { t: 240, l: 'Prep.' }, { t: 60, l: '1 min' }, { t: 0, l: 'START' }].map(({ t, l }) => (
              <div key={t} className={`px-1.5 py-0.5 rounded ${countdown <= t + 30 && countdown > t - 30 ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400'}`}>{l}</div>
            ))}
          </div>
          <div className="flex gap-3 mt-4 w-full">
            <button onClick={() => setCountdownActive(p => !p)}
              className={`flex-1 py-3 rounded-xl font-bold flex items-center justify-center gap-2 shadow-lg ${countdownActive ? 'bg-amber-600 hover:bg-amber-500 text-white' : 'bg-green-600 hover:bg-green-500 text-white'}`}>
              {countdownActive ? <Square size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
              {countdownActive ? 'PAUSA' : 'START'}
            </button>
          </div>
          <div className="grid grid-cols-4 gap-2 w-full mt-3">
            {[5, 4, 3, 1].map(m => (
              <button key={m} onClick={() => syncTimer(m)} className="bg-slate-700 hover:bg-slate-600 text-white py-2 rounded-lg font-bold font-mono text-sm shadow">{m}:00</button>
            ))}
          </div>
        </div>

        {/* LINEA DI PARTENZA — Acquisizione 2 punti */}
        <div className="bg-slate-800 rounded-2xl border border-slate-700 p-4 space-y-3">
          <h3 className="text-slate-300 font-bold text-sm flex items-center gap-2"><Flag size={14} className="text-red-400" /> Linea di Partenza</h3>
          <div className="grid grid-cols-2 gap-3">
            {/* Pin End (Sinistra) */}
            <button onClick={() => setPinEnd({ lat: boatData.lat, lon: boatData.lon })}
              className={`relative flex flex-col items-center justify-center rounded-2xl border-4 py-5 transition-all active:scale-95
                ${pinEnd ? 'bg-rose-900/40 border-rose-500 shadow-[0_0_15px_rgba(244,63,94,0.25)]' : 'bg-slate-900 border-slate-700 hover:border-rose-700'}`}>
              <span className="text-2xl mb-1">🔴</span>
              <span className="text-white font-black text-sm">Boa (Pin)</span>
              <span className="text-[10px] text-slate-400 mt-0.5">Pin End · Sinistra</span>
              {pinEnd && <span className="absolute bottom-2 text-[9px] text-rose-400 font-mono">✓ {pinEnd.lat.toFixed(4)}N</span>}
            </button>
            {/* RC Boat (Dritta) */}
            <button onClick={() => setRcBoat({ lat: boatData.lat, lon: boatData.lon })}
              className={`relative flex flex-col items-center justify-center rounded-2xl border-4 py-5 transition-all active:scale-95
                ${rcBoat ? 'bg-green-900/40 border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.25)]' : 'bg-slate-900 border-slate-700 hover:border-green-700'}`}>
              <span className="text-2xl mb-1">🟢</span>
              <span className="text-white font-black text-sm">Barca Giuria</span>
              <span className="text-[10px] text-slate-400 mt-0.5">RC · Dritta</span>
              {rcBoat && <span className="absolute bottom-2 text-[9px] text-green-400 font-mono">✓ {rcBoat.lat.toFixed(4)}N</span>}
            </button>
          </div>
          {rcBoat && pinEnd && (
            <div className="text-[10px] text-slate-500 font-mono text-center">
              Lunghezza linea: ~{(calcDistance(rcBoat.lat, rcBoat.lon, pinEnd.lat, pinEnd.lon) * 1852).toFixed(0)} m
            </div>
          )}
        </div>

        {/* LINE BIAS */}
        {rcBoat && pinEnd && lineBiasDir && (
          <div className={`p-4 rounded-2xl border-2 flex flex-col items-center text-center transition-colors
            ${lineBiasDir === 'rc' ? 'bg-green-900/30 border-green-500' : lineBiasDir === 'pin' ? 'bg-rose-900/30 border-rose-500' : 'bg-slate-800 border-slate-600'}`}>
            <div className="text-slate-400 text-[10px] font-bold uppercase mb-1">Vantaggio Linea (Line Bias)</div>
            <div className="text-2xl font-black text-white">{lineBiasLabel}</div>
            <div className="mt-2 w-full h-3 rounded-full bg-slate-700 overflow-hidden">
              <div className={`h-full rounded-full transition-all ${lineBiasDir === 'rc' ? 'bg-green-500 ml-auto' : lineBiasDir === 'pin' ? 'bg-rose-500' : 'bg-slate-400 mx-auto'}`}
                style={{ width: lineBiasDir === 'square' ? '100%' : '55%' }} />
            </div>
            <div className="flex justify-between w-full text-[9px] font-mono mt-1">
              <span className="text-rose-400">◄ Boa (Pin)</span><span className="text-green-400">Giuria (RC) ►</span>
            </div>
          </div>
        )}

        {/* TTL / Delta */}
        {rcBoat && pinEnd && (
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 flex flex-col justify-between">
              <div>
                <div className="text-slate-400 text-[10px] font-bold uppercase mb-0.5">Dist. alla Linea</div>
                <div className="text-2xl font-mono font-bold text-white">{distToLineProjM !== null ? `${distToLineProjM.toFixed(0)} m` : '---'}</div>
                <div className="text-[10px] text-slate-500">{distToLineProjM !== null ? `${(distToLineProjM / 1852 * 10).toFixed(1)} cbl` : ''}</div>
              </div>
              <div className="mt-3 border-t border-slate-700 pt-2">
                <div className="text-cyan-400 text-[10px] font-bold uppercase mb-0.5 flex items-center gap-1"><Timer size={10} /> TTL</div>
                <div className="text-3xl font-mono font-black text-cyan-400">{formatTime(ttlSec)}</div>
              </div>
            </div>
            <div className={`p-4 rounded-xl border-2 flex flex-col justify-between transition-colors
              ${timeDelta === null ? 'bg-slate-800 border-slate-700'
                : timeDelta > 20 ? 'bg-red-900/40 border-red-500'
                  : timeDelta >= -5 ? 'bg-green-900/40 border-green-500'
                    : 'bg-orange-900/40 border-orange-500'}`}>
              <div>
                <div className="text-slate-400 text-[10px] font-bold uppercase mb-0.5">Status</div>
                <div className="text-xs font-bold text-white leading-tight">
                  {timeDelta === null ? 'Attesa velocità' : timeDelta > 20 ? '⬅️ In anticipo' : timeDelta >= -5 ? '✅ Zona start' : '⚡ In ritardo!'}
                </div>
              </div>
              <div className="mt-3">
                <div className="text-slate-400 text-[10px] font-bold uppercase mb-0.5">Delta</div>
                <div className={`text-4xl font-mono font-black ${timeDelta !== null && timeDelta > 0 ? 'text-green-400' : 'text-orange-400'}`}>
                  {timeDelta !== null ? `${timeDelta > 0 ? '+' : ''}${Math.round(timeDelta)}s` : '---'}
                </div>
              </div>
            </div>
          </div>
        )}

        {(!rcBoat || !pinEnd) && (
          <div className="bg-orange-900/40 border border-orange-600 text-orange-200 p-3 rounded-xl text-xs flex items-start gap-2">
            <MapPin className="text-orange-400 shrink-0 w-4 h-4 mt-0.5" />
            <p>Pinga <strong>Barca Giuria</strong> e <strong>Boa (Pin)</strong> per calcolare TTL e Line Bias.</p>
          </div>
        )}

        <p className="text-center text-[10px] text-slate-600 px-4">Delta = 0s: sei sulla linea allo sparo. Zona ideale: +0s → +20s.</p>
      </div>
    );
  };

  // ════════════════════════════════════════════════════════════════════════════
  // TAB 6 — TACTICAL MAP
  // ════════════════════════════════════════════════════════════════════════════
  const renderMap = () => (
    <div className="flex flex-col h-full overflow-hidden pb-20">
      <div className="px-4 pt-4 pb-2 shrink-0">
        <h2 className="text-xl font-black text-white flex items-center gap-2"><Map className="text-blue-400 w-5 h-5" /> Mappa Tattica</h2>
        <p className="text-slate-400 text-xs">Chartplotter live · usa +/− per zoomare</p>
      </div>
      <div className="flex-1 px-4 overflow-hidden flex flex-col">
        <TacticalMap boat={boatData} marks={marks} rcBoat={rcBoat} pinEnd={pinEnd} />
        {/* Legend */}
        <div className="flex gap-3 mt-3 flex-wrap text-[10px] font-mono text-slate-400">
          <span className="flex items-center gap-1"><span className="w-3 h-3 bg-blue-400 rounded-full inline-block" /> Barca</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 bg-yellow-400 rounded-sm inline-block" /> Boa ORC</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 bg-orange-400 rounded-sm inline-block" /> Boa GIALLA</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 bg-green-400 rounded-sm inline-block" /> Giuria RC</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 bg-rose-400 inline-block" style={{ clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' }} /> Pin</span>
        </div>
      </div>
    </div>
  );

  // ════════════════════════════════════════════════════════════════════════════
  // TAB 7 — POLARS: rendered via proper component below (PolarsTab)

  // ════════════════════════════════════════════════════════════════════════════
  // NAVIGATION TABS
  // ════════════════════════════════════════════════════════════════════════════
  const tabs = [
    { icon: Compass, label: 'Nav' },
    { icon: Route, label: 'Rotta' },
    { icon: MapPin, label: 'Boe' },
    { icon: Wind, label: 'Vento' },
    { icon: Brain, label: 'AI' },
    { icon: Flag, label: 'Start' },
    { icon: Map, label: 'Mappa' },
    { icon: BarChart2, label: 'Polari' },
  ];

  return (
    <div className="h-screen w-full bg-slate-950 font-sans flex flex-col overflow-hidden text-slate-200">

      {showWifiPanel && (
        <WifiPanel onClose={() => setShowWifiPanel(false)} onConnect={wifiConnect} onDisconnect={wifiDisconnect}
          status={wifiStatus} errorMsg={wifiError} bytesReceived={bytesReceived} messagesReceived={messagesReceived}
          config={wifiConfig} onConfigChange={setWifiConfig} packets={wifiPackets} clearPackets={wifiClearPackets} />
      )}

      {/* Header */}
      <header className="bg-slate-900 border-b border-slate-800 px-4 py-2.5 flex justify-between items-center z-50 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-black text-xs shadow">RYC</div>
          <div>
            <span className="font-bold text-white text-sm tracking-wide">NavCenter <span className="text-slate-500 font-normal">Pro</span></span>
            <div className="text-[9px] text-slate-600 font-mono leading-tight">43° Camp. Invernale · RYC</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowWifiPanel(true)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold border transition-colors
              ${isWifiOn ? 'bg-green-900/50 text-green-400 border-green-600 shadow-[0_0_10px_rgba(74,222,128,0.2)]'
                : isWifiConnecting ? 'bg-yellow-900/50 text-yellow-400 border-yellow-600 animate-pulse'
                  : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-500'}`}>
            {isWifiOn || isWifiConnecting ? <Wifi size={12} /> : <WifiOff size={12} />}
            {isWifiOn ? `${wifiConfig.protocol}:${wifiConfig.port}` : isWifiConnecting ? 'CONN...' : 'Wi-Fi'}
          </button>
          <button onClick={() => setSimulatorActive(p => !p)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-bold border transition-colors
              ${simulatorActive ? 'bg-green-900/50 text-green-400 border-green-600' : 'bg-slate-800 text-slate-400 border-slate-700'}`}>
            {simulatorActive ? <Square size={10} fill="currentColor" /> : <Play size={10} fill="currentColor" />} SIM
          </button>
        </div>
      </header>

      {/* Status bar */}
      {(isWifiOn || simulatorActive) && (
        <div className={`px-4 py-1 flex items-center gap-3 text-[10px] font-mono shrink-0
          ${isWifiOn ? 'bg-green-950/50 border-b border-green-900/50 text-green-500' : 'bg-slate-900 border-b border-slate-800 text-green-600'}`}>
          <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
          {isWifiOn ? `WiFi · ${wifiConfig.host}:${wifiConfig.port} · ${messagesReceived} msg · ${(bytesReceived / 1024).toFixed(1)} KB` : 'SIMULATORE ATTIVO'}
          <span className="ml-auto text-slate-600">SOG {boatData.SOG.toFixed(1)} kt · HDG {boatData.HDG.toFixed(0)}°</span>
        </div>
      )}

      {/* Main content */}
      <main className="flex-grow relative overflow-hidden">
        {activeTab === 0 && renderDashboard()}
        {activeTab === 1 && renderCourse()}
        {activeTab === 2 && renderPing()}
        {activeTab === 3 && renderWind()}
        {activeTab === 4 && renderAI()}
        {activeTab === 5 && renderStart()}
        {activeTab === 6 && renderMap()}
        {activeTab === 7 && <PolarsTab polarTarget={polarTarget} polarSamples={polarSamples} setPolarTarget={setPolarTarget} setPolarSamples={setPolarSamples} calcVmg={calcVmg} boatData={boatData} />}
      </main>

      {/* Bottom nav — 8 tabs with scroll */}
      <nav className="shrink-0 bg-slate-900 border-t border-slate-800 z-50" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex justify-around items-center py-1 px-1 overflow-x-auto scrollbar-none">
          {tabs.map((tab, idx) => (
            <button key={idx} onClick={() => setActiveTab(idx)}
              className={`flex flex-col items-center justify-center min-w-[52px] h-12 px-1 rounded-xl transition-all shrink-0
                ${activeTab === idx ? 'text-blue-400 bg-slate-800 shadow-[inset_0_-2px_0_rgba(96,165,250,1)]' : 'text-slate-500 hover:text-slate-300'}`}>
              <tab.icon size={18} className="mb-0.5" />
              <span className="text-[9px] font-bold uppercase tracking-tight">{tab.label}</span>
            </button>
          ))}
        </div>
      </nav>

      <style dangerouslySetInnerHTML={{ __html: `.scrollbar-none::-webkit-scrollbar{display:none}.scrollbar-none{-ms-overflow-style:none;scrollbar-width:none}` }} />
    </div>
  );
};

export default Index;
