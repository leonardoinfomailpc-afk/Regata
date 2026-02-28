import { useState, useEffect, useRef, useCallback } from 'react';

export type Protocol = 'TCP' | 'UDP';
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WifiConfig {
  host: string;
  port: number;
  protocol: Protocol;
}

export interface DataPacket {
  id: string;
  timestamp: Date;
  data: string;
  bytes: number;
}

interface UseWifiConnectionResult {
  status: ConnectionStatus;
  lastMessage: string | null;
  errorMsg: string | null;
  connect: (config: WifiConfig) => void;
  disconnect: () => void;
  bytesReceived: number;
  messagesReceived: number;
  packets: DataPacket[];
  clearPackets: () => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 2000;
const MAX_PACKETS = 500;

/**
 * Browser limitation: raw TCP/UDP sockets are not available in browsers.
 * Both TCP and UDP modes connect via WebSocket:
 *   - TCP  → ws://host:port
 *   - UDP  → ws://host:port/udp
 *
 * The instrument server / multiplexer MUST expose a WebSocket endpoint.
 * Many modern NMEA WiFi bridges (iKommunicate, Yacht Devices, Digital Yacht,
 * Shipmodul MiniPlex-3Wi, nCLog bridge, Signal K) natively support WebSocket.
 *
 * If your device only broadcasts raw UDP, you need a lightweight bridge like:
 *   npx ws-udp-bridge --udp-port 2000 --ws-port 2000
 */
export function useWifiConnection(onMessage: (msg: string) => void): UseWifiConnectionResult {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [bytesReceived, setBytesReceived] = useState(0);
  const [messagesReceived, setMessagesReceived] = useState(0);
  const [packets, setPackets] = useState<DataPacket[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configRef = useRef<WifiConfig | null>(null);
  const attemptRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  // Buffer for incomplete NMEA sentences (data may arrive split across frames)
  const bufferRef = useRef('');

  const addPacket = useCallback((data: string, bytes: number) => {
    const pkt: DataPacket = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      data,
      bytes,
    };
    setPackets(prev => {
      const next = [pkt, ...prev];
      return next.length > MAX_PACKETS ? next.slice(0, MAX_PACKETS) : next;
    });
  }, []);

  const clearPackets = useCallback(() => {
    setPackets([]);
  }, []);

  const clearReconnect = useCallback(() => {
    if (reconnectRef.current) {
      clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    clearReconnect();
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      wsRef.current.onopen = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    configRef.current = null;
    attemptRef.current = 0;
    bufferRef.current = '';
    setStatus('disconnected');
    setErrorMsg(null);
  }, [clearReconnect]);

  /** Validate and build WebSocket URL */
  const buildWsUrl = (config: WifiConfig): string | null => {
    const { host, port, protocol } = config;
    
    // Validate host
    const trimmedHost = (host || '').trim();
    if (!trimmedHost) return null;
    
    // Validate port
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
    
    // Build URL
    const path = protocol === 'UDP' ? '/udp' : '';
    return `ws://${trimmedHost}:${port}${path}`;
  };

  /** Process incoming raw data: split into NMEA lines, handle buffering */
  const processIncomingData = useCallback((rawData: string) => {
    if (!rawData) return;

    // Append to buffer for handling split frames
    const combined = bufferRef.current + rawData;
    
    // Split on line endings
    const parts = combined.split(/\r?\n/);
    
    // Last element might be incomplete — keep in buffer
    bufferRef.current = parts[parts.length - 1] || '';
    
    // Process all complete lines
    for (let i = 0; i < parts.length - 1; i++) {
      const line = parts[i].trim();
      if (!line) continue;

      const byteLen = new TextEncoder().encode(line).length;
      
      setLastMessage(line);
      setBytesReceived(b => b + byteLen);
      setMessagesReceived(m => m + 1);
      addPacket(line, byteLen);
      
      // Forward to NMEA parser
      onMessageRef.current(line);
    }

    // If there's a long buffer without newline, it might be a single sentence
    // Flush if it looks complete (starts with $ and has *)
    if (bufferRef.current.length > 0) {
      const buf = bufferRef.current.trim();
      if (buf.startsWith('$') && buf.includes('*')) {
        bufferRef.current = '';
        const byteLen = new TextEncoder().encode(buf).length;
        setLastMessage(buf);
        setBytesReceived(b => b + byteLen);
        setMessagesReceived(m => m + 1);
        addPacket(buf, byteLen);
        onMessageRef.current(buf);
      }
      // Also flush if buffer is getting too large (possible non-NMEA data)
      else if (bufferRef.current.length > 512) {
        const overflow = bufferRef.current;
        bufferRef.current = '';
        const byteLen = new TextEncoder().encode(overflow).length;
        setBytesReceived(b => b + byteLen);
        setMessagesReceived(m => m + 1);
        addPacket(overflow, byteLen);
        onMessageRef.current(overflow);
      }
    }
  }, [addPacket]);

  const connectInternal = useCallback((config: WifiConfig) => {
    // Close existing connection cleanly
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      wsRef.current.onopen = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    const url = buildWsUrl(config);
    if (!url) {
      setStatus('error');
      setErrorMsg(`Configurazione non valida: host="${config.host}" porta=${config.port}`);
      return;
    }

    setStatus('connecting');
    setErrorMsg(null);
    bufferRef.current = '';

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      intentionalCloseRef.current = false;

      ws.onopen = () => {
        attemptRef.current = 0;
        setStatus('connected');
        setErrorMsg(null);
        addPacket(`[SYS] ✓ Connesso a ${url} (${config.protocol})`, 0);
      };

      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data === 'string') {
          processIncomingData(event.data);
        } else if (event.data instanceof Blob) {
          // Handle binary data (some bridges send Blob)
          event.data.text().then(text => {
            processIncomingData(text);
          }).catch(() => {
            // ignore blob read errors
          });
        } else if (event.data instanceof ArrayBuffer) {
          const text = new TextDecoder().decode(event.data);
          processIncomingData(text);
        }
      };

      ws.onerror = (_ev) => {
        // onerror fires before onclose — set error message but let onclose handle status
        setErrorMsg(`Connessione fallita a ${url}. Verifica che il server WebSocket sia attivo.`);
      };

      ws.onclose = (ev) => {
        wsRef.current = null;
        
        if (intentionalCloseRef.current) {
          setStatus('disconnected');
          return;
        }

        // Auto-reconnect with exponential backoff
        if (attemptRef.current < MAX_RECONNECT_ATTEMPTS && configRef.current) {
          attemptRef.current += 1;
          const delay = RECONNECT_BASE_MS * Math.pow(1.5, attemptRef.current - 1);
          setStatus('connecting');
          setErrorMsg(`Riconnessione ${attemptRef.current}/${MAX_RECONNECT_ATTEMPTS}... (${(delay / 1000).toFixed(1)}s)`);
          addPacket(`[SYS] ⚠ Disconnesso (code: ${ev.code}). Tentativo ${attemptRef.current}/${MAX_RECONNECT_ATTEMPTS}...`, 0);
          
          reconnectRef.current = setTimeout(() => {
            if (configRef.current) connectInternal(configRef.current);
          }, delay);
        } else {
          setStatus('error');
          const reason = ev.code === 1006 
            ? 'Connessione rifiutata o server non raggiungibile.' 
            : `Chiusura code: ${ev.code}`;
          setErrorMsg(`${reason} ${attemptRef.current >= MAX_RECONNECT_ATTEMPTS ? 'Tentativi esauriti.' : ''}`);
          addPacket(`[SYS] ✗ Connessione persa definitivamente. ${reason}`, 0);
        }
      };
    } catch (e) {
      setStatus('error');
      const msg = e instanceof DOMException 
        ? `URL WebSocket non valido. Controlla host e porta.`
        : `Errore: ${e instanceof Error ? e.message : 'sconosciuto'}`;
      setErrorMsg(msg);
      addPacket(`[SYS] ✗ ${msg}`, 0);
    }
  }, [clearReconnect, addPacket, processIncomingData]);

  const connect = useCallback((config: WifiConfig) => {
    intentionalCloseRef.current = false;
    configRef.current = config;
    attemptRef.current = 0;
    bufferRef.current = '';
    setBytesReceived(0);
    setMessagesReceived(0);
    setPackets([]);
    connectInternal(config);
  }, [connectInternal]);

  // Cleanup on unmount
  useEffect(() => () => {
    intentionalCloseRef.current = true;
    if (reconnectRef.current) clearTimeout(reconnectRef.current);
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  return { status, lastMessage, errorMsg, connect, disconnect, bytesReceived, messagesReceived, packets, clearPackets };
}
