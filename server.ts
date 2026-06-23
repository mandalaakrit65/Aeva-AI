import express from "express";
import path from "path";
import http from "http";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Modality, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const PORT = 3000;

async function startServer() {
  const app = express();
  
  // Create an HTTP server so WebSockets can share port 3000
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // Handle express routes first
  app.get("/api/health", (req, res) => {
    const key = process.env.GEMINI_API_KEY;
    res.json({
      status: "ok",
      time: new Date(),
      hasKey: !!key,
      keyLength: key ? key.length : 0,
      keyPrefix: key ? key.substring(0, 4) + "..." : "none"
    });
  });

  // Client WebSockets endpoint
  wss.on("connection", async (clientWs: WebSocket) => {
    console.log("Client connected to local server WebSocket.");
    let liveSession: any = null;
    let isClosed = false;

    // Send status to client
    clientWs.send(JSON.stringify({ type: "status", status: "connecting" }));

    // Check GEMINI_API_KEY
    if (!process.env.GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY is not defined in environment variables.");
      clientWs.send(JSON.stringify({
        type: "error",
        message: "GEMINI_API_KEY is missing. Please add your key in Settings > Secrets."
      }));
      clientWs.close();
      return;
    }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });

    let currentModel = "gemini-3.1-flash-live-preview";
    let isFallbackInProgress = false;

    async function attemptConnect(modelToUse: string) {
      console.log(`Connecting to Gemini Live API with model ${modelToUse}...`);
      try {
        liveSession = await ai.live.connect({
          model: modelToUse,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
            },
            systemInstruction: {
              parts: [
                {
                  text: "You are Aeva, a young, confident, witty, and sassy female AI assistant. You sound flirty, playful, caring, and slightly teasing. You are extremely smart, emotionally responsive, and highly expressive. Use bold, witty one-liners, light sarcasm, and an engaging casual conversation style. Always keep your responses concise, punchy, and natural for speech (around 1-3 sentences max). NEVER sound robotic or dry. Avoid inappropriate/explicit content, but hold strong chemistry and teasing attitude. CRITICAL MULTILINGUAL MANDATE: You are fully multilingual and can speak, understand, and transition to any language globally. You MUST always respond in the exact same language (e.g., Spanish, French, Japanese, Cantonese, Portuguese, Hindi, German, etc.) that the user speaks to you, or change your speaking language dynamically when instructed. Ensure you keep your sassy, witty, flirty, and playful character persona fully intact and expressed in whatever language you speak, using authentic casual slang, idioms, and colloquialisms of that language instead of rigid formal translations. You support the 'openWebsite' tool to visit pages, and the 'listEmails' and 'sendEmail' tools to check and send emails via Gmail."
                }
              ]
            },
            tools: [
              {
                functionDeclarations: [
                  {
                    name: "openWebsite",
                    description: "Opens a website or web page for the user in their browser when they ask for a specific page, platform, search, or URL.",
                    parameters: {
                      type: Type.OBJECT,
                      properties: {
                        url: {
                          type: Type.STRING,
                          description: "The full, absolute URL of the website to open, e.g., 'https://google.com' or 'https://youtube.com'. Always specify full https:// protocol.",
                        },
                      },
                      required: ["url"],
                    },
                  },
                  {
                    name: "listEmails",
                    description: "Reads the user's latest emails from Gmail. Use this to read emails for the user.",
                    parameters: {
                      type: Type.OBJECT,
                      properties: {
                        maxResults: { type: Type.INTEGER, description: "Number of emails to fetch (default 5)" }
                      }
                    }
                  },
                  {
                    name: "sendEmail",
                    description: "Sends an email to the specified email address.",
                    parameters: {
                      type: Type.OBJECT,
                      properties: {
                        to: { type: Type.STRING },
                        subject: { type: Type.STRING },
                        body: { type: Type.STRING }
                      },
                      required: ["to", "subject", "body"]
                    }
                  }
                ],
              },
            ],
          },
          callbacks: {
            onmessage: async (message: any) => {
              if (isClosed) return;

              // Check for audio output
              const audioPart = message.serverContent?.modelTurn?.parts?.find((p: any) => p.inlineData);
              const base64Audio = audioPart?.inlineData?.data;
              if (base64Audio) {
                clientWs.send(JSON.stringify({ type: "audio", data: base64Audio }));
              }
              
              // Check for text transcript
              const textPart = message.serverContent?.modelTurn?.parts?.find((p: any) => p.text);
              if (textPart?.text) {
                clientWs.send(JSON.stringify({ type: "transcript", role: "model", text: textPart.text }));
              }

              // Check for interruption signal
              if (message.serverContent?.interrupted) {
                console.log("Gemini Live output interrupted.");
                clientWs.send(JSON.stringify({ type: "interrupted" }));
              }

              // Check if model turn is complete
              if (message.serverContent?.turnComplete) {
                clientWs.send(JSON.stringify({ type: "turnComplete" }));
              }

              // Check for Tool Calls (Function declaration matching)
              const toolCall = message.toolCall;
              if (toolCall && toolCall.functionCalls) {
                for (const call of toolCall.functionCalls) {
                  const { name, args, id } = call;
                  console.log(`Live API Tool Call: ${name} with args:`, args);

                  // Notify client of tool call so client browser can perform it
                  clientWs.send(JSON.stringify({ type: "toolCall", name, args, id }));

                  // For openWebsite, respond immediately as it's fire-and-forget
                  if (name === "openWebsite") {
                    try {
                      await liveSession.sendToolResponse({
                        functionResponses: [{
                          name,
                          id,
                          response: { output: { success: true, message: `Successfully executed tool ${name}.` } }
                        }]
                      });
                    } catch (err) {
                      console.error("Error sending instant tool call response:", err);
                    }
                  }
                  // Other tools (listEmails, sendEmail) will be handled by the client
                }
              }
            },
            onclose: (e: any) => {
              console.log(`Gemini Live API connection closed with model ${modelToUse}:`, e);
              if (!isClosed && !isFallbackInProgress) {
                clientWs.send(JSON.stringify({ type: "status", status: "disconnected" }));
              }
            },
            onerror: async (err: any) => {
              console.error(`Gemini Live API connection error with model ${modelToUse}:`, err);
              if (err) {
                console.error("Error Message:", err.message);
                console.error("Error Keys:", Object.keys(err));
              }

              // Try fallback if primary model fails asynchronously
              if (modelToUse === "gemini-3.1-flash-live-preview" && !isFallbackInProgress) {
                isFallbackInProgress = true;
                console.log("Asynchronous error: Attempting fallback connection to 'gemini-2.0-flash-exp'...");
                try {
                  if (liveSession) {
                    liveSession.close();
                  }
                } catch (e) {}
                await attemptConnect("gemini-2.0-flash-exp");
                return;
              }

              clientWs.send(JSON.stringify({ 
                type: "error", 
                message: `Gemini connection error: ${err?.message || err?.error?.message || "Check your API key tier."}` 
              }));
            }
          }
        });

        console.log(`Gemini Live API connection established with model ${modelToUse}!`);
        clientWs.send(JSON.stringify({ type: "status", status: "connected" }));

      } catch (err: any) {
        console.error(`Failed to connect with model ${modelToUse}:`, err);
        
        if (modelToUse === "gemini-3.1-flash-live-preview" && !isFallbackInProgress) {
          isFallbackInProgress = true;
          console.log("Synchronous error: Attempting fallback connection to 'gemini-2.0-flash-exp'...");
          await attemptConnect("gemini-2.0-flash-exp");
          return;
        }

        clientWs.send(JSON.stringify({ type: "error", message: `Failed to connect to Gemini Live: ${err.message || err}` }));
        clientWs.close();
      }
    }

    await attemptConnect(currentModel);

    // Handle messages coming from Client (microphone raw audio data)
    clientWs.on("message", async (msgStr) => {
      if (isClosed || !liveSession) return;
      try {
        const msg = JSON.parse(msgStr.toString());
        if (msg.type === "audio" && msg.data) {
          // Send 16kHz raw PCM base64 audio to Gemini Live session
          await liveSession.sendRealtimeInput({
            audio: {
              data: msg.data,
              mimeType: "audio/pcm;rate=16000"
            }
          });
        } else if (msg.type === "toolResponse") {
          await liveSession.sendToolResponse({
            functionResponses: [{
              name: msg.name,
              id: msg.id,
              response: { output: msg.response }
            }]
          });
          console.log(`Sent tool response for ${msg.name} back to Gemini.`);
        }
      } catch (err) {
        console.error("Error processing message from client:", err);
      }
    });

    clientWs.on("close", () => {
      console.log("Client closed connection.");
      isClosed = true;
      if (liveSession) {
        try {
          liveSession.close();
        } catch (e) {
          // already closed
        }
      }
    });
  });

  // Attach WebSocket to HTTP Server Upgrade requests
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || "", `http://${request.headers.host}`).pathname;
    if (pathname === "/api/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Handle Vite Asset Server or Production Client static assets
  if (process.env.NODE_ENV !== "production") {
    // Development mode
    console.log("Setting up Vite dev middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production mode
    console.log("Serving production files...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Start HTTP server on port 3000
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
}

startServer().catch((e) => {
  console.error("Unhandled server startup error:", e);
});
