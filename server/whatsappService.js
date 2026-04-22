import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import WhatsAppWeb from "whatsapp-web.js";

const { Client, LocalAuth } = WhatsAppWeb;
const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sessionsPath = path.join(__dirname, "sessions");
const manualDisconnectStates = new Set(["UNPAIRED", "UNPAIRED_IDLE", "LOGOUT"]);

const createSessionState = () => ({
  status: "idle",
  qrCode: null,
  phoneNumber: null,
  connectionState: null,
  lastDisconnectReason: null,
  disconnectedByPhone: false,
  lastError: null,
  lastUpdatedAt: new Date().toISOString(),
});

const createDispatchState = () => ({
  inProgress: false,
  total: 0,
  processed: 0,
  successCount: 0,
  failedCount: 0,
  items: [],
  startedAt: null,
  finishedAt: null,
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lockFileNames = [
  "DevToolsActivePort",
  "lockfile",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  path.join("Default", "LOCK"),
];

const isLockedProfileError = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("browser is already running") ||
    message.includes("userDataDir") ||
    message.includes("SingletonLock")
  );
};

export function createWhatsAppService(io, persistence = null) {
  let client = null;
  let isManualShutdown = false;
  let initializingPromise = null;
  let stateMonitorId = null;
  let stateMonitorBusy = false;
  let disconnectingClient = null;
  let sessionState = createSessionState();
  let dispatchState = createDispatchState();

  const broadcastSession = () => {
    io.emit("session-state", sessionState);
  };

  const broadcastDispatch = () => {
    io.emit("dispatch-state", dispatchState);
  };

  const updateSession = (patch) => {
    sessionState = {
      ...sessionState,
      ...patch,
      lastUpdatedAt: new Date().toISOString(),
    };
    broadcastSession();
  };

  const replaceDispatch = (nextState) => {
    dispatchState = nextState;
    broadcastDispatch();
  };

  const ensureSessionsPath = async () => {
    await fs.mkdir(sessionsPath, { recursive: true });
  };

  const clearStateMonitor = () => {
    if (stateMonitorId) {
      clearInterval(stateMonitorId);
      stateMonitorId = null;
    }

    stateMonitorBusy = false;
  };

  const isPhoneDisconnectReason = (reason) =>
    manualDisconnectStates.has(String(reason ?? "").toUpperCase());

  const formatDisconnectMessage = (reason) => {
    const normalizedReason = String(reason ?? "UNKNOWN").toUpperCase();

    if (isPhoneDisconnectReason(normalizedReason)) {
      return "Conexao removida manualmente no celular. Gere um novo QR code para conectar novamente.";
    }

    return `WhatsApp desconectado. Motivo: ${normalizedReason}.`;
  };

  const startStateMonitor = (watchedClient) => {
    clearStateMonitor();

    stateMonitorId = setInterval(async () => {
      if (stateMonitorBusy || !watchedClient || client !== watchedClient) {
        return;
      }

      stateMonitorBusy = true;

      try {
        const state = await watchedClient.getState();

        if (client !== watchedClient) {
          return;
        }

        updateSession({
          connectionState: state,
        });

        if (isPhoneDisconnectReason(state)) {
          await handleUnexpectedDisconnect(watchedClient, state);
        }
      } catch {
        // O evento disconnected/change_state cobre a maior parte dos cenarios;
        // aqui evitamos poluir a UI com erros transitórios do monitor.
      } finally {
        stateMonitorBusy = false;
      }
    }, 15000);
  };

  const cleanupSessionLocks = async () => {
    await Promise.all(
      lockFileNames.map((fileName) =>
        fs.rm(path.join(sessionsPath, "session-principal", fileName), {
          force: true,
          recursive: true,
        }),
      ),
    );
  };

  const canConnectToPort = (port) =>
    new Promise((resolve) => {
      const socket = new net.Socket();

      socket.setTimeout(600);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, "127.0.0.1");
    });

  const readDevToolsPort = async () => {
    try {
      const content = await fs.readFile(
        path.join(sessionsPath, "session-principal", "DevToolsActivePort"),
        "utf8",
      );
      const [rawPort] = content.split(/\r?\n/, 1);
      const port = Number(rawPort);
      return Number.isInteger(port) && port > 0 ? port : null;
    } catch {
      return null;
    }
  };

  const terminateProcessListeningOnPort = async (port) => {
    if (!port) {
      return false;
    }

    try {
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-Command",
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
        ]);
        const pid = Number(String(stdout).trim());

        if (!Number.isInteger(pid) || pid <= 0) {
          return false;
        }

        await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
        return true;
      }

      const { stdout } = await execFileAsync("bash", [
        "-lc",
        `lsof -ti tcp:${port} | head -n 1`,
      ]);
      const pid = Number(String(stdout).trim());

      if (!Number.isInteger(pid) || pid <= 0) {
        return false;
      }

      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  };

  const recoverLockedProfile = async () => {
    const port = await readDevToolsPort();

    if (port && (await canConnectToPort(port))) {
      await terminateProcessListeningOnPort(port);
      await delay(500);
    }

    await cleanupSessionLocks();
  };

  const handleUnexpectedDisconnect = async (watchedClient, reason) => {
    if (isManualShutdown || !watchedClient || disconnectingClient === watchedClient) {
      return;
    }

    disconnectingClient = watchedClient;
    clearStateMonitor();

    try {
      const normalizedReason = String(reason ?? "UNKNOWN").toUpperCase();
      const disconnectedByPhone = isPhoneDisconnectReason(normalizedReason);

      updateSession({
        status: disconnectedByPhone ? "unpaired" : "disconnected",
        qrCode: null,
        phoneNumber: null,
        connectionState: normalizedReason,
        lastDisconnectReason: normalizedReason,
        disconnectedByPhone,
        lastError: formatDisconnectMessage(normalizedReason),
      });

      await disposeClient({ clearAuth: disconnectedByPhone });
    } finally {
      disconnectingClient = null;
    }
  };

  const disposeClient = async ({ clearAuth = false } = {}) => {
    const currentClient = client;
    clearStateMonitor();
    client = null;
    initializingPromise = null;

    if (currentClient) {
      try {
        await currentClient.destroy();
      } catch {
        // Ignora falhas ao fechar a sessao do navegador.
      }
    }

    if (clearAuth) {
      await fs.rm(sessionsPath, { recursive: true, force: true });
      await ensureSessionsPath();
    }
  };

  const normalizeNumber = (value, defaultCountryCode = "55") => {
    let digits = String(value ?? "").replace(/\D/g, "");

    if (!digits) {
      return "";
    }

    if (defaultCountryCode && digits.length >= 10 && digits.length <= 11) {
      digits = `${defaultCountryCode}${digits}`;
    }

    return digits;
  };

  const initialize = async () => {
    if (client) {
      return sessionState;
    }

    if (initializingPromise) {
      return initializingPromise;
    }

    initializingPromise = (async () => {
      await ensureSessionsPath();
      const launchClient = async () => {
      updateSession({
        status: "initializing",
        qrCode: null,
        connectionState: null,
        lastDisconnectReason: null,
        disconnectedByPhone: false,
        lastError: null,
      });

        const nextClient = new Client({
          authStrategy: new LocalAuth({
            clientId: "principal",
            dataPath: sessionsPath,
          }),
          puppeteer: {
            headless: true,
            args: [
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-dev-shm-usage",
            ],
          },
        });

        client = nextClient;

        nextClient.on("qr", async (qr) => {
          const qrCode = await QRCode.toDataURL(qr);
          updateSession({
            status: "qr",
            qrCode,
            phoneNumber: null,
            connectionState: "PAIRING",
            lastDisconnectReason: null,
            disconnectedByPhone: false,
            lastError: null,
          });
        });

        nextClient.on("authenticated", () => {
          updateSession({
            status: "authenticated",
            connectionState: "OPENING",
            lastDisconnectReason: null,
            disconnectedByPhone: false,
            lastError: null,
          });
        });

        nextClient.on("change_state", async (state) => {
          if (client !== nextClient || isManualShutdown) {
            return;
          }

          updateSession({
            connectionState: state,
          });

          if (isPhoneDisconnectReason(state)) {
            await handleUnexpectedDisconnect(nextClient, state);
          }
        });

        nextClient.on("ready", () => {
          updateSession({
            status: "ready",
            qrCode: null,
            connectionState: "CONNECTED",
            lastDisconnectReason: null,
            disconnectedByPhone: false,
            lastError: null,
            phoneNumber: nextClient.info?.wid?.user ?? null,
          });
          startStateMonitor(nextClient);
        });

        nextClient.on("auth_failure", async (message) => {
          clearStateMonitor();
          updateSession({
            status: "auth_failure",
            qrCode: null,
            phoneNumber: null,
            connectionState: null,
            lastDisconnectReason: "AUTH_FAILURE",
            disconnectedByPhone: false,
            lastError: message || "Falha de autenticacao.",
          });
          await disposeClient({ clearAuth: true });
        });

        nextClient.on("disconnected", async (reason) => {
          if (isManualShutdown || client !== nextClient) {
            return;
          }
          await handleUnexpectedDisconnect(nextClient, reason);
        });

        await nextClient.initialize();
        return sessionState;
      };

      try {
        return await launchClient();
      } catch (error) {
        await disposeClient();

        if (isLockedProfileError(error)) {
          await recoverLockedProfile();

          try {
            return await launchClient();
          } catch (retryError) {
            await disposeClient();
            updateSession({
              status: "error",
              qrCode: null,
              phoneNumber: null,
              connectionState: null,
              lastDisconnectReason: "LOCKED_PROFILE",
              disconnectedByPhone: false,
              lastError:
                retryError instanceof Error
                  ? retryError.message
                  : "Nao foi possivel recuperar a sessao do WhatsApp.",
            });
            throw retryError;
          }
        }

        updateSession({
          status: "error",
          qrCode: null,
          phoneNumber: null,
          connectionState: null,
          lastDisconnectReason: "INITIALIZATION_ERROR",
          disconnectedByPhone: false,
          lastError:
            error instanceof Error ? error.message : "Nao foi possivel iniciar o WhatsApp.",
        });
        throw error;
      } finally {
        initializingPromise = null;
      }
    })();

    return initializingPromise;
  };

  const logout = async () => {
    if (dispatchState.inProgress) {
      throw new Error("Aguarde o disparo terminar antes de desconectar.");
    }

    isManualShutdown = true;
    const currentClient = client;
    client = null;
    initializingPromise = null;

    try {
      if (currentClient) {
        try {
          await currentClient.logout();
        } catch {
          // Algumas sessoes expiram antes do logout formal.
        }

        try {
          await currentClient.destroy();
        } catch {
          // Ignora falhas ao encerrar o navegador automatizado.
        }
      }

      await fs.rm(sessionsPath, { recursive: true, force: true });
      await ensureSessionsPath();

      sessionState = createSessionState();
      dispatchState = createDispatchState();
      broadcastSession();
      broadcastDispatch();
    } finally {
      isManualShutdown = false;
    }
  };

  const sendBulkMessages = async ({
    numbers,
    contacts = [],
    sourceFileName = null,
    message,
    defaultCountryCode = "55",
    intervalMs = 2500,
  }) => {
    if (!client || sessionState.status !== "ready") {
      throw new Error("Conecte o WhatsApp antes de iniciar o disparo.");
    }

    if (dispatchState.inProgress) {
      throw new Error("Ja existe um disparo em andamento.");
    }

    if (!Array.isArray(numbers) || numbers.length === 0) {
      throw new Error("Importe ao menos um numero antes de enviar.");
    }

    const trimmedMessage = String(message ?? "").trim();

    if (!trimmedMessage) {
      throw new Error("Digite a mensagem que sera enviada.");
    }

    const uniqueNumbers = [];
    const seen = new Set();

    for (const entry of numbers) {
      const normalized = normalizeNumber(entry, defaultCountryCode);
      if (!normalized || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      uniqueNumbers.push(normalized);
    }

    if (uniqueNumbers.length === 0) {
      throw new Error("Nenhum numero valido foi encontrado na planilha.");
    }

    const safeInterval = Number.isFinite(Number(intervalMs))
      ? Math.max(500, Math.min(10000, Number(intervalMs)))
      : 2500;
    const startedAt = new Date().toISOString();
    let successCount = 0;
    let failedCount = 0;
    const items = [];
    let campaignId = null;

    if (persistence) {
      const contactsToPersist =
        Array.isArray(contacts) && contacts.length > 0
          ? contacts
          : uniqueNumbers.map((number) => ({
              name: "",
              phone: number,
              normalizedPhone: number,
              notes: "",
            }));

      await persistence.ensureContacts({
        contacts: contactsToPersist,
        sourceFileName,
      });

      const campaignResult = await persistence.createCampaign({
        message: trimmedMessage,
        intervalMs: safeInterval,
        totalContacts: uniqueNumbers.length,
        sourceFileName,
        sessionPhoneNumber: sessionState.phoneNumber,
      });

      campaignId = campaignResult?.enabled ? campaignResult.campaignId : null;
    }

    replaceDispatch({
      inProgress: true,
      total: uniqueNumbers.length,
      processed: 0,
      successCount: 0,
      failedCount: 0,
      items: [],
      startedAt,
      finishedAt: null,
    });

    for (const [index, number] of uniqueNumbers.entries()) {
      let resultItem;

      try {
        const numberId = await client.getNumberId(number);

        if (!numberId?._serialized) {
          throw new Error("Numero nao encontrado no WhatsApp.");
        }

        await client.sendMessage(numberId._serialized, trimmedMessage);
        successCount += 1;
        resultItem = {
          number,
          status: "sent",
          detail: "Mensagem enviada com sucesso.",
          sentAt: new Date().toISOString(),
        };
      } catch (error) {
        failedCount += 1;
        resultItem = {
          number,
          status: "failed",
          detail:
            error instanceof Error ? error.message : "Falha ao enviar a mensagem.",
          sentAt: new Date().toISOString(),
        };
      }

      items.push(resultItem);

      if (persistence && campaignId) {
        await persistence.recordCampaignMessage({
          campaignId,
          phone: number,
          status: resultItem.status,
          detail: resultItem.detail,
          sentAt: resultItem.sentAt,
        });

        await persistence.updateCampaignProgress({
          campaignId,
          processedContacts: index + 1,
          successCount,
          failedCount,
        });
      }

      replaceDispatch({
        inProgress: true,
        total: uniqueNumbers.length,
        processed: index + 1,
        successCount,
        failedCount,
        items: [...items],
        startedAt,
        finishedAt: null,
      });

      if (index < uniqueNumbers.length - 1) {
        await delay(safeInterval);
      }
    }

    const finishedAt = new Date().toISOString();
    const finalState = {
      inProgress: false,
      total: uniqueNumbers.length,
      processed: uniqueNumbers.length,
      successCount,
      failedCount,
      items: [...items],
      startedAt,
      finishedAt,
    };

    replaceDispatch(finalState);

    if (persistence && campaignId) {
      await persistence.finishCampaign({
        campaignId,
        processedContacts: uniqueNumbers.length,
        successCount,
        failedCount,
      });
    }

    return finalState;
  };

  return {
    getSessionState: () => sessionState,
    getDispatchState: () => dispatchState,
    initialize,
    logout,
    shutdown: () => disposeClient(),
    sendBulkMessages,
  };
}
