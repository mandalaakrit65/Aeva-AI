/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from "react";
import { 
  motion, 
  AnimatePresence 
} from "motion/react";
import { 
  Mic, 
  MicOff, 
  Power, 
  Sparkles, 
  Volume2, 
  Globe, 
  Wifi, 
  WifiOff, 
  VolumeX, 
  AlertCircle, 
  ExternalLink,
  Flame,
  Terminal,
  Clock,
  Heart,
  Smile,
  LogIn,
  LogOut,
  History,
  Activity,
  Cpu,
  Layers,
  MessageSquare,
  Settings
} from "lucide-react";
import { ConnectionState, ToastMessage, ToolCallLog } from "./types";
import { auth, loginWithGoogle, logout, saveHistory, getHistory, getAccessToken } from "./firebase";
import { onAuthStateChanged, User } from "firebase/auth";

export default function App() {
  // Session UI states
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [toolLogs, setToolLogs] = useState<ToolCallLog[]>([]);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [sessionStartTime, setSessionStartTime] = useState<Date | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  // Audio peaks states for modern responsive glow circles
  const [micLevel, setMicLevel] = useState<number>(0);
  const [speakerLevel, setSpeakerLevel] = useState<number>(0);

  // User Auth & History
  const [user, setUser] = useState<User | null>(null);
  const userRef = useRef<User | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLogs, setHistoryLogs] = useState<any[]>([]);

  // Refs to avoid state closure capture in WebSocket/WebAudio callbacks
  const connectionStateRef = useRef<ConnectionState>('disconnected');
  const isModelSpeakingRef = useRef<boolean>(false);
  const lastSpeakingTimeRef = useRef<number>(0);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  // Web Audio Contexts & WebSocket Refs
  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);

  // Audio Analyser Nodes for real-time waveforms
  const userAnalyserRef = useRef<AnalyserNode | null>(null);
  const aevaAnalyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);

  // Queue control for seamless 24kHz voice output playback
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  // Add toast helper
  const addToast = (text: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, text, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  };

  // Keep track of session active timer
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      userRef.current = currentUser;
      if (currentUser) {
        // Load history when user logs in
        getHistory(currentUser.uid).then(setHistoryLogs);
      } else {
        setHistoryLogs([]);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    let timer: any = null;
    if (connectionState !== 'disconnected' && connectionState !== 'connecting') {
      if (!sessionStartTime) setSessionStartTime(new Date());
      timer = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      setSessionStartTime(null);
      setElapsedSeconds(0);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [connectionState]);

  // Clean raw-pcm to base64 helper
  const pcmToBase64 = (pcmData: Int16Array): string => {
    const uint8 = new Uint8Array(pcmData.buffer);
    let binary = "";
    const len = uint8.length;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    return btoa(binary);
  };

  // Float32 array sound capture -> convert to 16-bit PCM (Int16)
  const float32ToInt16 = (float32Array: Float32Array): Int16Array => {
    const buffer = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      buffer[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return buffer;
  };

  // Convert Aeva's 24kHz PCM16 back to Float32 array for playback
  const base64ToFloat32 = (base64: string): Float32Array => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }
    return float32Array;
  };

  // Play audio chunk at exactly 24kHz gaplessly
  const playAudioChunk = (base64Audio: string) => {
    const audioContext = outputAudioCtxRef.current;
    if (!audioContext || isMuted) return;

    if (audioContext.state === "suspended") {
      audioContext.resume();
    }

    try {
      const float32 = base64ToFloat32(base64Audio);
      const buffer = audioContext.createBuffer(1, float32.length, 24000);
      buffer.copyToChannel(float32, 0);

      const source = audioContext.createBufferSource();
      source.buffer = buffer;

      // Connect to speaker volume peak analyser
      const analyser = aevaAnalyserRef.current;
      if (analyser) {
        source.connect(analyser);
        analyser.connect(audioContext.destination);
      } else {
        source.connect(audioContext.destination);
      }

      const currentTime = audioContext.currentTime;
      if (nextStartTimeRef.current < currentTime) {
        nextStartTimeRef.current = currentTime + 0.04; // 40ms dynamic network delay buffer
      }

      source.start(nextStartTimeRef.current);
      activeSourcesRef.current.push(source);

      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter((src) => src !== source);
        if (activeSourcesRef.current.length === 0) {
          setConnectionState('idle');
          setSpeakerLevel(0);
        }
      };

      nextStartTimeRef.current += buffer.duration;
      setConnectionState('speaking');
    } catch (err) {
      console.error("Failed to decode or play audio chunk:", err);
    }
  };

  // Immediate Interruption Handler (cuts off speaking stream)
  const handleInterruption = () => {
    console.log("Interrupting active audio playback pipeline...");
    activeSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch (e) {
        // already stopped
      }
    });
    activeSourcesRef.current = [];
    nextStartTimeRef.current = 0;
    setSpeakerLevel(0);
    setConnectionState('idle');
  };

  // Disconnect & Shut Down Connection
  const disconnectSession = () => {
    setConnectionState('disconnected');
    setMicLevel(0);
    setSpeakerLevel(0);
    isModelSpeakingRef.current = false;

    // Cancel animation loop
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }

    // Stop speaking models
    activeSourcesRef.current.forEach((src) => {
      try { src.stop(); } catch (e) {}
    });
    activeSourcesRef.current = [];
    nextStartTimeRef.current = 0;

    // Shut down microphone capturing
    if (processorNodeRef.current) {
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }

    // Close contexts
    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close().catch(() => {});
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close().catch(() => {});
      outputAudioCtxRef.current = null;
    }

    // Close websocket
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {}
      wsRef.current = null;
    }

    addToast("Neural link to Aeva disconnected safely.", "warn");
  };

  // Initialize Audio & WebSocket Connection
  const connectSession = async () => {
    setErrorMessage(null);
    setConnectionState('connecting');

    try {
      // 1. Get microphone raw access first
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      // 2. Setup standard 16kHz context for mic stream and 24kHz context for Aeva output
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      inputAudioCtxRef.current = inputCtx;
      outputAudioCtxRef.current = outputCtx;

      // Resume context if needed
      await inputCtx.resume();
      await outputCtx.resume();

      // 3. Connect analysers to monitor volume of both sides in real time
      const uAnalyser = inputCtx.createAnalyser();
      uAnalyser.fftSize = 256;
      userAnalyserRef.current = uAnalyser;

      const aevaAnalyser = outputCtx.createAnalyser();
      aevaAnalyser.fftSize = 256;
      aevaAnalyserRef.current = aevaAnalyser;

      // 4. Connect microphone stream through a script processor node to process 16kHz float sample buffers
      const source = inputCtx.createMediaStreamSource(stream);
      source.connect(uAnalyser);

      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(inputCtx.destination);
      processorNodeRef.current = processor;

      // 5. Connect WebSocket endpoint
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/live`;
      console.log(`Connecting to server proxy at ${wsUrl}`);
      
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      // 6. Hook up mic processor callbacks to stream straight to WebSocket
      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        
        // Read input raw float audio
        const channelData = e.inputBuffer.getChannelData(0);
        
        // Check if user is actively talking (RMS energy threshhold)
        let sum = 0;
        for (let i = 0; i < channelData.length; i++) {
          sum += channelData[i] * channelData[i];
        }
        const rms = Math.sqrt(sum / channelData.length);
        
        // Dynamically update mic volumes state
        setMicLevel(rms);

        const currentConnectionState = connectionStateRef.current;
        const now = Date.now();

        // If Aeva is speaking, or just finished speaking recently (500ms debounce),
        // do not send user microphone data over WebSocket 
        // to prevent echo loop / feedback from triggering instant automatic interruption.
        if (currentConnectionState === 'speaking' || isModelSpeakingRef.current) {
          lastSpeakingTimeRef.current = now;
          return;
        }
        
        // Prevent room reverb from falsely triggering microphone right after speaking stops
        if (now - lastSpeakingTimeRef.current < 500) {
          return;
        }

        // Update connection state to listening if user is actively voicing
        if (rms > 0.015) {
          setConnectionState('listening');
        }

        // Send raw PCM16 base64 block
        const pcm16Ints = float32ToInt16(channelData);
        const base64Str = pcmToBase64(pcm16Ints);
        
        ws.send(JSON.stringify({
          type: "audio",
          data: base64Str
        }));
      };

      // 7. WebSocket Handlers
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          if (msg.type === "status") {
            if (msg.status === "connected") {
              setConnectionState('idle');
              addToast("Aeva synchronisation established! She is awake.", "success");
            } else if (msg.status === "disconnected") {
              disconnectSession();
            }
          }

          else if (msg.type === "audio" && msg.data) {
            isModelSpeakingRef.current = true;
            playAudioChunk(msg.data);
          }

          else if (msg.type === "interrupted") {
            isModelSpeakingRef.current = false;
            handleInterruption();
            addToast("Aeva interrupted.", "info");
          }

          else if (msg.type === "turnComplete") {
            isModelSpeakingRef.current = false;
          }

          else if (msg.type === "transcript") {
            // Save transcript to history if logged in
            if (userRef.current?.uid && msg.text) {
              const text = msg.text;
              saveHistory(userRef.current.uid, text).then(() => {
                // Refresh history list
                getHistory(userRef.current!.uid).then(setHistoryLogs);
              });
            }
          }

          else if (msg.type === "toolCall") {
            const { name, args, id } = msg;
            console.log(`Executing tool on client side: ${name}`, args);
            
            // Log tool execution
            const callLog: ToolCallLog = {
              id: id || Math.random().toString(),
              name,
              args,
              timestamp: new Date()
            };
            setToolLogs(prev => [callLog, ...prev]);

            // Execute browser function
            if (name === "openWebsite" && args && args.url) {
              const url = args.url;
              addToast(`Aeva opened webpage: ${url}`, "success");
              
              // Open in new tab or popup
              setTimeout(() => {
                window.open(url, "_blank");
              }, 400);
            } 
            else if (name === "listEmails" || name === "sendEmail") {
              const executeGmailTool = async () => {
                try {
                  const token = await getAccessToken();
                  if (!token) {
                    ws.send(JSON.stringify({ type: "toolResponse", name, id, response: { success: false, message: "User is not authenticated with Gmail. Please ask them to login." } }));
                    return;
                  }

                  if (name === "listEmails") {
                    const maxResults = args.maxResults || 5;
                    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`, {
                      headers: { Authorization: `Bearer ${token}` }
                    });
                    const data = await res.json();
                    
                    if (data.messages && data.messages.length > 0) {
                      const emails = await Promise.all(data.messages.map(async (m: any) => {
                        const mRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=subject&metadataHeaders=from`, {
                          headers: { Authorization: `Bearer ${token}` }
                        });
                        const mData = await mRes.json();
                        const headers = mData.payload?.headers || [];
                        const subject = headers.find((h: any) => h.name.toLowerCase() === 'subject')?.value || 'No Subject';
                        const from = headers.find((h: any) => h.name.toLowerCase() === 'from')?.value || 'Unknown';
                        return { id: m.id, snippet: mData.snippet, subject, from };
                      }));
                      ws.send(JSON.stringify({ type: "toolResponse", name, id, response: { success: true, emails } }));
                    } else {
                      ws.send(JSON.stringify({ type: "toolResponse", name, id, response: { success: true, emails: [] } }));
                    }
                  } 
                  else if (name === "sendEmail") {
                    const { to, subject, body } = args;
                    const confirmed = window.confirm(`Aeva wants to send an email to ${to} with subject "${subject}". Allow?`);
                    if (!confirmed) {
                      ws.send(JSON.stringify({ type: "toolResponse", name, id, response: { success: false, message: "User denied the request to send email." } }));
                      return;
                    }
                    
                    const messageParts = [
                      `To: ${to}`,
                      `Subject: ${subject}`,
                      '',
                      body
                    ];
                    const message = messageParts.join('\n');
                    const encodedMessage = btoa(unescape(encodeURIComponent(message))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
                    
                    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                      method: 'POST',
                      headers: { 
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json'
                      },
                      body: JSON.stringify({ raw: encodedMessage })
                    });
                    
                    if (res.ok) {
                      addToast(`Email sent to ${to}`, "success");
                      ws.send(JSON.stringify({ type: "toolResponse", name, id, response: { success: true, message: "Email sent successfully." } }));
                    } else {
                      const errData = await res.json();
                      ws.send(JSON.stringify({ type: "toolResponse", name, id, response: { success: false, message: "Failed to send email: " + JSON.stringify(errData) } }));
                    }
                  }
                } catch (err: any) {
                  ws.send(JSON.stringify({ type: "toolResponse", name, id, response: { success: false, message: err.message } }));
                }
              };
              executeGmailTool();
            }
          }

          else if (msg.type === "error") {
            setErrorMessage(msg.message);
            disconnectSession();
          }

        } catch (e) {
          console.error("Error reading server WebSocket message:", e);
        }
      };

      ws.onclose = () => {
        console.log("WebSocket relation dissolved.");
        if (connectionState !== 'disconnected') {
          disconnectSession();
        }
      };

      ws.onerror = (err) => {
        console.error("Local websocket error:", err);
        setErrorMessage("Network socket failure inside web environment. Check server logs.");
        disconnectSession();
      };

      // Start the live audio levels monitor animation loop
      startLevelsMonitor();

    } catch (err: any) {
      console.error("Interactive initialization failed:", err);
      setErrorMessage(err.message || "Failed to prompt microphone permission or open socket.");
      setConnectionState('disconnected');
    }
  };

  // Monitor voice wave peaks dynamically
  const startLevelsMonitor = () => {
    const loop = () => {
      // Analyze speaker peaks if playing back
      const aevaAnalyser = aevaAnalyserRef.current;
      if (aevaAnalyser && activeSourcesRef.current.length > 0) {
        const dataArray = new Uint8Array(aevaAnalyser.frequencyBinCount);
        aevaAnalyser.getByteTimeDomainData(dataArray);
        
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const val = (dataArray[i] - 128) / 128;
          sum += val * val;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        setSpeakerLevel(rms);
      } else {
        setSpeakerLevel(0);
      }

      animationFrameIdRef.current = requestAnimationFrame(loop);
    };
    animationFrameIdRef.current = requestAnimationFrame(loop);
  };

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
    };
  }, []);

  // Visual text helper for Aeva's expressive states
  const getStateBadge = () => {
    switch (connectionState) {
      case "disconnected":
        return { name: "Offline", color: "bg-neutral-800 text-neutral-400 border-neutral-700" };
      case "connecting":
        return { name: "Syncing Core...", color: "bg-indigo-950 text-indigo-300 border-indigo-800 animate-pulse" };
      case "idle":
        return { name: "Listening", color: "bg-emerald-950 text-emerald-300 border-emerald-800" };
      case "listening":
        return { name: "Capturing You", color: "bg-pink-950 text-pink-300 border-pink-800 animate-pulse" };
      case "speaking":
        return { name: "Expressing", color: "bg-fuchsia-950 text-fuchsia-300 border-fuchsia-800 animate-pulse" };
    }
  };

  // Dynamic state formatting descriptions
  const getSubStatusText = () => {
    switch (connectionState) {
      case "disconnected":
        return "Aeva is sleeping. Toggle power to link systems.";
      case "connecting":
        return "Synchronizing neural voice codecs with cloud matrix...";
      case "idle":
        return "Core listening. Speak naturally in any language, she is right here.";
      case "listening":
        return "Recording voice frequencies...";
      case "speaking":
        return "Aeva is talking... Stop speaking to hear her better.";
    }
  };

  // Format elapsed session seconds
  const formatTime = (totalSecs: number) => {
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const badge = getStateBadge();

  return (
    <div className="min-h-screen mesh-bg text-neutral-100 flex flex-col font-sans overflow-hidden relative h-svh justify-between selection:bg-[#FF007F] selection:text-white" id="main-container">
      
      {/* Dynamic Cyber Grid & Organic Vector Auroras */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.015)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.015)_1px,transparent_1px)] bg-[size:24px_24px] pointer-events-none opacity-60" />
      <div className="absolute inset-0 bg-radial-gradient opacity-40 pointer-events-none" style={{ background: "radial-gradient(circle at 50% 50%, rgba(255, 0, 127, 0.12) 0%, rgba(112, 0, 255, 0.08) 40%, transparent 75%)" }}></div>
      
      {/* Abstract ambient backdrop light streams */}
      <div className="absolute top-10 left-[15%] w-[400px] h-[400px] rounded-full bg-[#FF007F]/5 blur-[120px] pointer-events-none animate-pulse" />
      <div className="absolute bottom-10 right-[15%] w-[500px] h-[500px] rounded-full bg-[#7000FF]/5 blur-[140px] pointer-events-none animate-pulse" style={{ animationDuration: '8s' }} />

      {/* Main Container Layout with collapsible Drawer panel on Desktop */}
      <div className="flex-1 flex flex-col relative overflow-hidden z-10">
        
        {/* Header Panel */}
        <header className="px-4 sm:px-8 py-3 sm:py-4 flex items-center justify-between border-b border-white/5 bg-black/35 backdrop-blur-xl shrink-0" id="app-header">
          <div className="flex items-center gap-2.5 sm:gap-4">
            <div className="relative group">
              <div className="absolute -inset-1 bg-gradient-to-r from-[#FF007F] to-[#7000FF] rounded-full opacity-60 blur-md group-hover:opacity-100 transition duration-500"></div>
              <div className="relative w-9 h-9 sm:w-11 sm:h-11 bg-black rounded-full flex items-center justify-center border border-white/10">
                <span className="text-[10px] sm:text-xs font-black tracking-widest text-[#FF007F]">AE</span>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <span className="text-base sm:text-lg font-bold tracking-tight text-white font-display">
                  Aeva
                </span>
                <span className="text-[9px] sm:text-[10px] bg-[#FF007F]/10 text-[#FF007F] border border-[#FF007F]/20 font-mono px-1.2 sm:px-1.5 py-0.5 rounded font-bold uppercase tracking-widest">
                  Live
                </span>
              </div>
              <p className="text-[9px] text-neutral-400/80 font-mono uppercase tracking-wider hidden sm:block">Core Quantum Interface</p>
            </div>
          </div>

          {/* Neural Sync badge and elapsed metadata */}
          <div className="flex items-center gap-2.5 sm:gap-6 text-xs tracking-wider">
            {connectionState !== 'disconnected' && connectionState !== 'connecting' && (
              <div className="hidden md:flex items-center gap-2 bg-white/5 border border-white/5 px-3 py-1.5 rounded-full font-mono text-neutral-400">
                <span className="w-1.5 h-1.5 rounded-full bg-[#FF007F] animate-ping"></span>
                <span>SYNC TIME: <span className="text-white font-medium">{formatTime(elapsedSeconds)}</span></span>
              </div>
            )}

            <div className="flex items-center gap-1.5 sm:gap-2 bg-neutral-900/60 border border-white/5 px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-full">
              <span className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${connectionState === 'disconnected' ? 'bg-neutral-600' : 'bg-[#FF007F] animate-[pulse_1.5s_infinite]'}`}></span>
              <span className="text-neutral-300 font-mono text-[9px] sm:text-[11px] uppercase tracking-wider sm:tracking-widest">{badge.name}</span>
            </div>
            
            <div className="h-5 w-px bg-white/10"></div>
            
            {user ? (
              <div className="flex items-center gap-1.5 sm:gap-2.5">
                <button 
                  onClick={() => setShowHistory(!showHistory)}
                  className={`flex items-center justify-center gap-1.5 px-2.5 py-1 px-3 py-1.5 sm:px-3 sm:py-1.5 rounded-lg text-[11px] sm:text-xs font-medium border transition-all cursor-pointer ${showHistory ? 'bg-[#FF007F]/15 border-[#FF007F]/30 text-white' : 'bg-white/5 border-white/5 text-neutral-400 hover:text-white'}`}
                >
                  <History className="w-3.5 h-3.5 text-[#FF007F]" />
                  <span className="hidden sm:inline">Memory Logs</span>
                </button>
                <button 
                  onClick={() => logout()}
                  className="w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center rounded-lg bg-white/5 border border-white/5 text-neutral-400 hover:text-neutral-200 transition-all cursor-pointer"
                  title="Disconnect User Profile"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button 
                onClick={() => loginWithGoogle()}
                className="flex items-center gap-1.5 px-2.5 py-1.5 sm:px-4 sm:py-1.5 rounded-lg bg-gradient-to-r from-[#FF007F] to-[#7000FF] text-white hover:opacity-95 transition-all cursor-pointer text-[11px] sm:text-xs font-semibold shadow-[0_0_15px_rgba(255,0,127,0.2)] animate-pulse-glow"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span className="hidden min-[420px]:inline">Link Google</span>
                <span className="min-[420px]:hidden">Login</span>
              </button>
            )}
          </div>
        </header>

        {/* Outer Split Layout supporting Sidebar Drawer on desktop */}
        <div className="flex-1 flex relative overflow-hidden">
          
          {/* Main Voice Space */}
          <div className="flex-1 flex flex-col items-center justify-center px-4 relative select-none">
            
            {/* Background dynamic ambient aura */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 min-[400px]:w-80 min-[400px]:h-80 sm:w-[380px] sm:h-[380px] rounded-full bg-gradient-to-tr from-[#FF007F]/8 to-[#7000FF]/5 blur-[70px] sm:blur-[90px] pointer-events-none transition-all duration-700"
              style={{
                transform: `translate(-50%, -50%) scale(${1 + (connectionState === 'speaking' ? speakerLevel * 1.6 : connectionState === 'listening' ? micLevel * 1.2 : 0)})`,
              }}
            />

            {/* Central visual Stage holding the fluid bioluminescent core */}
            <div className="flex flex-col items-center justify-center gap-6 sm:gap-10 relative w-full max-w-lg z-10" id="avatar-container">
              
              {/* Outer Glowing Stage Rings */}
              <div className="relative w-64 h-64 min-[400px]:w-72 min-[400px]:h-72 sm:w-[340px] sm:h-[340px] md:w-[380px] md:h-[380px] flex items-center justify-center">
                
                {/* Orbital dust nodes flying around core */}
                {connectionState !== 'disconnected' && (
                  <>
                    <div className="absolute w-full h-full rounded-full border border-dashed border-[#FF007F]/10 animate-slow-spin pointer-events-none"></div>
                    <div className="absolute w-[80%] h-[80%] rounded-full border border-white/5 scale-100 transition-all pointer-events-none"></div>
                    
                    {/* Glowing orbiting star points */}
                    <div className="absolute w-2.5 h-2.5 rounded-full bg-[#FF007F] shadow-[0_0_15px_#FF007F] animate-pulse-glow" style={{ top: '22%', left: '15%' }}></div>
                    <div className="absolute w-1.5 h-1.5 rounded-full bg-[#7000FF] shadow-[0_0_12px_#7000FF]" style={{ bottom: '26%', right: '12%' }} />
                    <div className="absolute w-1 h-1 rounded-full bg-white/40" style={{ top: '65%', left: '8%' }} />
                  </>
                )}

                {/* Animated visualizer ripples wrapping the avatar orb */}
                <AnimatePresence>
                  {(connectionState === 'speaking' || connectionState === 'listening') && (
                    <>
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.85 }}
                        animate={{ 
                          opacity: [0.1, 0.35, 0.1], 
                          scale: 1.12 + (connectionState === 'speaking' ? speakerLevel * 0.9 : micLevel * 0.7)
                        }}
                        transition={{ repeat: Infinity, duration: 2.2, ease: "easeInOut" }}
                        className="absolute inset-0 rounded-full border border-[#FF007F]/25 blur-xs pointer-events-none"
                      />
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ 
                          opacity: [0.05, 0.2, 0.05], 
                          scale: 1.25 + (connectionState === 'speaking' ? speakerLevel * 1.4 : micLevel * 1.0)
                        }}
                        transition={{ repeat: Infinity, duration: 3.5, ease: "easeInOut" }}
                        className="absolute inset-0 rounded-full border border-[#7000FF]/15 blur-sm pointer-events-none"
                      />
                    </>
                  )}
                </AnimatePresence>

                {/* Bioluminescent Sphere Container */}
                <div className={`w-48 h-48 min-[400px]:w-52 min-[400px]:h-52 sm:w-56 sm:h-56 md:w-64 md:h-64 rounded-full p-[2px] transition-all duration-700 relative z-20 
                  ${connectionState === 'disconnected' 
                    ? 'bg-neutral-800/40 shadow-inner' 
                    : 'bg-gradient-to-tr from-[#7000FF] via-neutral-900 to-[#FF007F] shadow-[0_0_50px_rgba(255,0,127,0.35)]'
                  }`}
                >
                  <button
                    id="power-button"
                    onClick={connectionState === 'disconnected' ? connectSession : disconnectSession}
                    aria-label="Toggle Synaptic Network Link"
                    className="w-full h-full rounded-full bg-neutral-950/95 flex items-center justify-center overflow-hidden relative group focus:outline-none cursor-pointer border border-[#ffffff04]"
                  >
                    {/* Fluid Hologram Shader Lines inside Button */}
                    <div className="absolute inset-0 opacity-10 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-white via-indigo-950 to-black pointer-events-none" />

                    {/* Central bioluminescent pulse point */}
                    {connectionState !== 'disconnected' && (
                      <div className="absolute inset-4 rounded-full bg-[radial-gradient(circle_at_center,_rgba(255,0,127,0.06)_0%,_transparent_65%)] pointer-events-none"></div>
                    )}

                    {/* Interactive center core icons */}
                    <div className="relative z-20 flex flex-col items-center justify-center text-center p-6">
                      {connectionState === 'disconnected' ? (
                        <div className="flex flex-col items-center gap-3.5">
                          <div className="w-14 h-14 rounded-full bg-neutral-900/80 group-hover:bg-[#FF007F]/15 flex items-center justify-center text-neutral-400 group-hover:text-[#FF007F] transition-all duration-300 border border-white/5 group-hover:border-[#FF007F]/30 shadow-2xl">
                            <Power className="w-6 h-6" />
                          </div>
                          <div className="space-y-1">
                            <span className="text-[10px] font-mono tracking-[0.2em] font-bold text-neutral-400 uppercase block group-hover:text-white transition-colors">Aeva State</span>
                            <span className="text-[12px] font-display font-medium text-neutral-500 group-hover:text-[#FF007F] transition-colors block uppercase">WAKE CORE</span>
                          </div>
                        </div>
                      ) : connectionState === 'connecting' ? (
                        <div className="flex flex-col items-center gap-3">
                          <div className="relative">
                            <div className="absolute -inset-2 rounded-full border-2 border-dashed border-[#FF007F] animate-spin"></div>
                            <Cpu className="w-7 h-7 text-indigo-400 animate-pulse" />
                          </div>
                          <span className="text-[10px] font-mono text-indigo-300 tracking-[0.15em] uppercase">Syncing...</span>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-3 group-hover:scale-105 transition-transform duration-300">
                          {/* Beautiful audio responsive morphing core shape */}
                          <div className="relative w-16 h-16 flex items-center justify-center">
                            
                            {/* Organic reactive wave element */}
                            <div 
                              className={`absolute inset-0 rounded-full bg-gradient-to-tr from-[#FF007F]/20 to-[#7000FF]/40 blur-xs transition-all duration-150 scale-100 ${connectionState === 'speaking' ? 'animate-[pulse_1s_infinite]' : ''}`} 
                              style={{
                                transform: `scale(${1 + (connectionState === 'speaking' ? speakerLevel * 1.5 : micLevel * 1.0)})`,
                                opacity: connectionState === 'speaking' ? 0.9 : 0.6
                              }}
                            />
                            
                            {/* Fluid sphere display inside */}
                            <div className="relative w-12 h-12 rounded-full bg-black/60 border border-[#FF007F]/40 flex items-center justify-center">
                              {connectionState === 'speaking' ? (
                                <Activity className="w-5 h-5 text-[#FF007F] animate-pulse" />
                              ) : connectionState === 'listening' ? (
                                <Mic className="w-5 h-5 text-indigo-400 animate-bounce" />
                              ) : (
                                <Smile className="w-5 h-5 text-neutral-400" />
                              )}
                            </div>
                          </div>

                          <div className="space-y-0.5">
                            <span className="text-[9px] font-mono text-[#FF007F] uppercase tracking-[0.15em] block">
                              {connectionState === 'speaking' ? 'Expressing' : 'Listening'}
                            </span>
                            <span className="text-[9px] text-neutral-500 uppercase font-bold tracking-widest block opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                              Sleep Core
                            </span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Highly futuristic Circular Audio waves running behind core glass */}
                    {(connectionState === 'idle' || connectionState === 'speaking' || connectionState === 'listening') && (
                      <div className="absolute inset-x-0 bottom-3 sm:bottom-6 flex items-end justify-center gap-[2.5px] sm:gap-[4px] h-9 sm:h-12 pointer-events-none z-10 px-4 sm:px-8">
                        <div className="w-[2.5px] sm:w-[3px] rounded-full bg-[#FF007F]/40 transition-all duration-150" style={{ height: `${3 + (connectionState === 'speaking' ? speakerLevel * 35 : micLevel * 10)}px` }} />
                        <div className="w-[2.5px] sm:w-[3px] rounded-full bg-[#FF007F] transition-all duration-150" style={{ height: `${6 + (connectionState === 'speaking' ? speakerLevel * 60 : micLevel * 16)}px` }} />
                        <div className="w-[2.5px] sm:w-[3px] rounded-full bg-[#FF007F] transition-all duration-150" style={{ height: `${10 + (connectionState === 'speaking' ? speakerLevel * 85 : micLevel * 22)}px` }} />
                        <div className="w-[2.5px] sm:w-[3px] rounded-full bg-white transition-all duration-150" style={{ height: `${16 + (connectionState === 'speaking' ? speakerLevel * 110 : micLevel * 32)}px` }} />
                        <div className="w-[2.5px] sm:w-[3px] rounded-full bg-[#7000FF] transition-all duration-150" style={{ height: `${10 + (connectionState === 'speaking' ? speakerLevel * 85 : micLevel * 22)}px` }} />
                        <div className="w-[2.5px] sm:w-[3px] rounded-full bg-[#7000FF] transition-all duration-150" style={{ height: `${6 + (connectionState === 'speaking' ? speakerLevel * 60 : micLevel * 16)}px` }} />
                        <div className="w-[2.5px] sm:w-[3px] rounded-full bg-[#7000FF]/40 transition-all duration-150" style={{ height: `${3 + (connectionState === 'speaking' ? speakerLevel * 35 : micLevel * 10)}px` }} />
                      </div>
                    )}
                  </button>
                </div>
              </div>

              {/* Status and Active Live Captions */}
              <div className="text-center z-10 flex flex-col items-center px-6" id="status-display">
                <div className="flex items-center gap-1.5 mb-2 bg-[#FF007F]/10 border border-[#FF007F]/15 px-3 py-1 rounded-full text-[10px] uppercase font-mono tracking-widest text-[#FF007F]">
                  <Layers className="w-3.5 h-3.5 inline animate-pulse" />
                  <span>
                    {connectionState === 'disconnected' && "Offline Mode"}
                    {connectionState === 'connecting' && "Core Syncing"}
                    {connectionState === 'idle' && "Synapses Connected"}
                    {connectionState === 'listening' && "Monitoring Stream"}
                    {connectionState === 'speaking' && "Modulating Voice"}
                  </span>
                </div>
                <p className="text-white/85 text-center text-lg sm:text-xl font-medium tracking-tight max-w-md leading-relaxed min-h-[56px] px-2">
                  {connectionState !== 'disconnected' && (
                    <span className="text-white drop-shadow-[0_0_15px_rgba(255,255,255,0.12)] font-display italic font-light">&ldquo;{getSubStatusText()}&rdquo;</span>
                  )}
                </p>
              </div>
            </div>
          </div>

          {/* Desktop Slide-Out Drawer Panel (Memories log & History view) */}
          <AnimatePresence>
            {showHistory && (
              <>
                {/* Mobile-only background blur overlay */}
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.5 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setShowHistory(false)}
                  className="fixed inset-0 bg-black backdrop-blur-xs z-40 md:hidden cursor-pointer"
                />

                <motion.aside 
                  initial={{ opacity: 0, x: 350 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 350 }}
                  transition={{ type: "spring", damping: 25, stiffness: 150 }}
                  className="w-full sm:w-[380px] bg-neutral-950/98 border-l border-white/5 backdrop-blur-2xl fixed md:absolute inset-y-0 right-0 z-50 flex flex-col shadow-2xl shrink-0 h-full"
                >
                  {/* Border glowing marker */}
                  <div className="absolute top-0 bottom-0 left-0 w-[1px] bg-gradient-to-b from-[#FF007F] via-indigo-500 to-transparent"></div>
                  
                  <div className="p-5 sm:p-6 border-b border-white/5 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-[#FF007F]/10 flex items-center justify-center border border-[#FF007F]/20">
                        <History className="text-[#FF007F] w-4 h-4" />
                      </div>
                      <div>
                        <h2 className="text-xs sm:text-sm font-bold text-white tracking-tight uppercase">Synaptic memory</h2>
                        <p className="text-[9px] sm:text-[10px] font-mono text-neutral-400">Captured Moments & Logs</p>
                      </div>
                    </div>
                    <button 
                      onClick={() => setShowHistory(false)}
                      className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/5 text-neutral-500 hover:text-white transition-colors cursor-pointer"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
                    {historyLogs.length === 0 ? (
                      <div className="text-center py-16 text-neutral-500">
                        <History className="w-10 h-10 mx-auto mb-3 opacity-20" />
                        <p className="text-sm font-light">No memories stored in database.</p>
                        <p className="text-xs text-neutral-600 mt-2 font-mono">Talk to Aeva to register entries.</p>
                      </div>
                    ) : (
                      historyLogs.map((log, i) => (
                        <div key={i} className="bg-white/[0.02] border border-white/5 rounded-xl p-3.5 sm:p-4 flex flex-col gap-2.5 hover:border-white/10 transition-all">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] text-[#FF007F] font-semibold bg-[#FF007F]/10 px-2 py-0.5 rounded uppercase font-mono">MEMORY ENTRY #{historyLogs.length - i}</span>
                            <span className="text-[9px] text-neutral-500 font-mono">
                              {log.timestamp?.toDate ? log.timestamp.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                          <p className="text-white/95 text-xs sm:text-sm leading-relaxed font-light">
                            <span className="text-[#FF007F] font-medium mr-1 uppercase text-[11px] sm:text-xs font-mono">Aeva &gt;</span> 
                            {log.agentMessage}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                  
                  {/* Micro-status at bottom of drawer */}
                  <div className="p-4 bg-black/40 border-t border-white/5 text-[9px] font-mono text-neutral-400 flex justify-between shrink-0">
                    <span>TOTAL ENTRIES: {historyLogs.length}</span>
                    <span className="text-emerald-500">DATABASE: PERSISTED</span>
                  </div>
                </motion.aside>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Floating Dynamic Toasts Portal Overlay */}
      <div className="fixed bottom-28 sm:bottom-24 left-4 right-4 z-40 pointer-events-none flex flex-col gap-2 max-w-sm mx-auto" id="toasts-portal">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 15, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
              className="pointer-events-auto text-xs rounded-xl border p-3.5 flex items-center justify-between gap-3 shadow-2xl backdrop-blur-md bg-neutral-950/95 border-[#FF007F]/20"
            >
              <div className="flex items-center gap-2.5">
                {toast.type === 'error' && <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />}
                {toast.type === 'success' && <Smile className="w-4 h-4 text-emerald-400 shrink-0" />}
                {toast.type === 'warn' && <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />}
                {toast.type === 'info' && <Sparkles className="w-4 h-4 text-[#FF007F] shrink-0" />}
                <p className="font-mono text-neutral-200 font-medium">{toast.text}</p>
              </div>
              <button 
                onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))}
                className="text-neutral-500 hover:text-white px-2 py-0.5 rounded"
              >
                ✕
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Futuristic control Footer displaying Gmail automation activity logs */}
      <footer className="w-full bg-black/60 backdrop-blur-xl border-t border-white/5 z-10 px-4 sm:px-8 py-3 sm:py-4 flex flex-col md:flex-row items-center justify-between gap-3 sm:gap-4 shrink-0" id="app-footer">
        
        {/* Toggle Audio and Mode indicators */}
        <div className="flex flex-wrap items-center justify-center md:justify-start gap-2.5 sm:gap-4 w-full md:w-auto">
          <button
            id="mute-button"
            disabled={connectionState === 'disconnected'}
            onClick={() => {
              setIsMuted(!isMuted);
              addToast(isMuted ? "Aeva voice output restored." : "Aeva voice muted. Stealth subtitle status online.", "info");
            }}
            className={`flex items-center justify-center gap-2 px-3.5 py-1.2 sm:px-4 sm:py-1.5 rounded-full border text-[10px] sm:text-[11px] uppercase tracking-wider font-semibold transition-all duration-300 cursor-pointer
              ${isMuted 
                ? 'bg-rose-950/40 border-rose-900 text-rose-300 hover:bg-rose-950/60' 
                : connectionState === 'disconnected'
                ? 'bg-transparent border-white/5 text-neutral-600 cursor-not-allowed'
                : 'bg-white/5 border-white/10 text-white/80 hover:bg-white/10'
              }`}
          >
            {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            <span>{isMuted ? "Muted Subtitles" : "Vocals Active"}</span>
          </button>
          
          <div className="text-neutral-500 text-[10px] tracking-wider uppercase flex items-center gap-2.5 sm:gap-4">
            <div className="hidden lg:block">
              VOICE MODEL: <span className="text-[#FF007F] font-bold">Kore (24kHz HQ)</span>
            </div>
            <div className="h-4 w-px bg-white/10 hidden lg:block"></div>
            <div className="flex items-center gap-1.5 bg-white/5 border border-white/5 px-2.5 py-1 rounded-full text-neutral-400">
              <Globe className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-[#FF007F] animate-[spin_10s_linear_infinite] inline" />
              <span className="text-[9px] sm:text-[10px]">Multilingual:</span>
              <span className="text-[#FF007F] font-bold text-[9px] sm:text-[10px]">Auto-Detect</span>
            </div>
          </div>
        </div>

        {/* Real-time Web Automation Tools logs console */}
        <div id="function-log-panel" className="w-full md:w-auto min-w-0 md:min-w-[300px] lg:min-w-[440px] bg-neutral-950/60 border border-white/5 rounded-xl p-2 sm:p-2.5 flex items-center justify-between gap-2.5 sm:gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Terminal className="w-3.5 h-3.5 text-[#7000FF] shrink-0" />
            <span className="text-[9px] sm:text-[10px] uppercase tracking-wider text-neutral-500 font-bold font-mono">LOG:</span>
            <div className="text-[10px] sm:text-[11px] font-mono text-neutral-300 truncate max-w-[130px] xs:max-w-[180px] sm:max-w-xs">
              {toolLogs.length > 0 ? (
                <span className="text-[#FF007F] flex items-center gap-1 font-semibold">
                  <span className="text-neutral-500">&gt;</span> openWebsite(&quot;{toolLogs[0].args.url}&quot;)
                </span>
              ) : (
                <span className="text-neutral-600 font-normal">Sensing browser actions...</span>
              )}
            </div>
          </div>
          {toolLogs.length > 0 && (
            <a 
              href={toolLogs[0].args.url} 
              target="_blank" 
              rel="noreferrer" 
              className="text-[9px] shrink-0 uppercase font-bold text-[#FF007F] hover:text-white flex items-center gap-1 bg-[#FF007F]/15 border border-[#FF007F]/20 px-2 sm:px-3 py-1 rounded-lg transition-all"
            >
              <span>Follow</span>
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          )}
        </div>

        {/* Personality Mood levels & latency monitors */}
        <div className="text-right text-[9px] text-neutral-500 font-mono hidden lg:block leading-relaxed select-none">
          CMD LINE: {toolLogs.length > 0 ? `execute_tool("${toolLogs[0].name}")` : "await_signal"}<br/>
          NEURAL LOAD: {connectionState === "speaking" ? "12%" : connectionState === "listening" ? "4.2%" : "0.5%"}<br/>
          COGNITIVE MOOD: {connectionState === "speaking" ? "0.98 SASSY" : connectionState === "listening" ? "0.85 ADAPTIVE" : "0.75 CHILL"}
        </div>
      </footer>

      {/* Full screen errors panel overlay */}
      {errorMessage && (
        <div id="error-screen" className="fixed inset-0 bg-neutral-950/98 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center z-[100]">
          <div className="w-14 h-14 rounded-full bg-[#FF007F]/10 border border-[#FF007F]/30 flex items-center justify-center text-[#FF007F] mb-4 shadow-[0_0_20px_rgba(255,0,127,0.3)]">
            <AlertCircle className="w-6 h-6 animate-bounce" />
          </div>
          <h2 className="text-lg font-bold text-white mb-2 uppercase tracking-tight">Sync Stream Disrupted</h2>
          <p className="text-sm text-neutral-400 max-w-sm leading-relaxed mb-6 font-light">
            {errorMessage}
          </p>
          <button
            onClick={() => {
              setErrorMessage(null);
              setConnectionState('disconnected');
            }}
            className="px-5 py-2.5 rounded-lg font-mono text-[11px] uppercase text-white font-bold bg-gradient-to-r from-[#FF007F] to-[#7000FF] hover:opacity-90 transition-opacity cursor-pointer shadow-lg shadow-[#FF007F]/20"
          >
            Reconnect core link
          </button>
        </div>
      )}
    </div>
  );
}
