import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Server as SocketServer } from "socket.io";
import { createWhatsAppService } from "./whatsappService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, "../client/dist");

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
});

const app = express();
const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: {
    origin: "*",
  },
});

const whatsappService = createWhatsAppService(io);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    session: whatsappService.getSessionState(),
    dispatch: whatsappService.getDispatchState(),
  });
});

app.get("/api/session", (_request, response) => {
  response.json(whatsappService.getSessionState());
});

app.post("/api/session/start", async (_request, response, next) => {
  try {
    await whatsappService.initialize();
    response.json(whatsappService.getSessionState());
  } catch (error) {
    next(error);
  }
});

app.post("/api/session/logout", async (_request, response, next) => {
  try {
    await whatsappService.logout();
    response.json(whatsappService.getSessionState());
  } catch (error) {
    next(error);
  }
});

app.post("/api/messages/send", async (request, response, next) => {
  try {
    const result = await whatsappService.sendBulkMessages(request.body ?? {});
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/messages/send-single", async (request, response, next) => {
  try {
    const result = await whatsappService.sendSingleMessage(request.body ?? {});
    response.json(result);
  } catch (error) {
    next(error);
  }
});

io.on("connection", (socket) => {
  socket.emit("session-state", whatsappService.getSessionState());
  socket.emit("dispatch-state", whatsappService.getDispatchState());
});

if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));

  app.get("*", (request, response, next) => {
    if (request.path.startsWith("/api")) {
      next();
      return;
    }

    response.sendFile(path.join(clientDistPath, "index.html"));
  });
}

app.use((error, _request, response, _next) => {
  const message = error instanceof Error ? error.message : "Erro interno no servidor.";
  response.status(400).json({ message });
});

const port = Number(process.env.PORT ?? 3001);
let shutdownInProgress = false;

const shutdownServer = async () => {
  if (shutdownInProgress) {
    return;
  }

  shutdownInProgress = true;

  try {
    await whatsappService.shutdown();
  } finally {
    process.exit(0);
  }
};

httpServer.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error("");
    console.error(`A porta ${port} ja esta em uso.`);
    console.error("Feche a instancia antiga do servidor ou rode com outra porta.");
    process.exit(1);
  }

  console.error("Falha ao iniciar o servidor:", error);
  process.exit(1);
});

process.once("SIGINT", shutdownServer);
process.once("SIGTERM", shutdownServer);

httpServer.listen(port, () => {
  console.log(`Servidor pronto em http://localhost:${port}`);
  whatsappService.initialize().catch((error) => {
    console.error("Nao foi possivel inicializar a sessao do WhatsApp:", error.message);
  });
});
