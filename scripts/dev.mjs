import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const requestedPort = Number(process.env.PORT ?? 3001);
const requestedClientPort = Number(process.env.VITE_PORT ?? 5173);
const portSearchLimit = 20;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tryConnect = (port, host) =>
  new Promise((resolve) => {
    const socket = new net.Socket();

    socket.setTimeout(700);
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
    socket.connect(port, host);
  });

const canConnect = async (port) => {
  if (await tryConnect(port, "127.0.0.1")) {
    return true;
  }

  return tryConnect(port, "::1");
};

const isOurServer = async (port) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(`http://localhost:${port}/api/health`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    return Boolean(data?.ok && data?.session && data?.dispatch);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

const isOurClient = async (port) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(`http://localhost:${port}/`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return false;
    }

    const html = await response.text();
    return (
      html.includes("<title>Disparo WhatsApp</title>") ||
      html.includes("Conecte por QR code") ||
      html.includes("/@vite/client")
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

const findFreePort = async (startPort) => {
  for (let port = startPort; port < startPort + portSearchLimit; port += 1) {
    if (!(await canConnect(port))) {
      return port;
    }
  }

  throw new Error(
    `Nao encontrei uma porta livre entre ${startPort} e ${startPort + portSearchLimit - 1}.`,
  );
};

const prefixStream = (name, stream) => {
  const reader = readline.createInterface({ input: stream });
  reader.on("line", (line) => {
    console.log(`[${name}] ${line}`);
  });
};

const children = [];
let shuttingDown = false;

const sanitizeEnv = (env) =>
  Object.fromEntries(
    Object.entries(env)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );

const shutdown = async (exitCode = 0) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGINT");
    }
  }

  await wait(400);
  process.exit(exitCode);
};

const spawnTask = (name, args, env) => {
  const isWindows = process.platform === "win32";
  const command = isWindows ? process.env.ComSpec || "cmd.exe" : "npm";
  const commandArgs = isWindows
    ? ["/d", "/s", "/c", `npm ${args.join(" ")}`]
    : args;

  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    env: sanitizeEnv(env),
    stdio: ["inherit", "pipe", "pipe"],
  });

  prefixStream(name, child.stdout);
  prefixStream(name, child.stderr);

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const normalizedCode = typeof code === "number" ? code : signal ? 1 : 0;
    console.log(
      `[${name}] processo encerrado${signal ? ` por ${signal}` : ` com codigo ${normalizedCode}`}.`,
    );
    shutdown(normalizedCode).catch(() => process.exit(normalizedCode));
  });

  children.push(child);
  return child;
};

process.once("SIGINT", () => {
  shutdown(0).catch(() => process.exit(0));
});

process.once("SIGTERM", () => {
  shutdown(0).catch(() => process.exit(0));
});

const basePortInUse = await canConnect(requestedPort);
let backendPort = requestedPort;
let reuseExistingBackend = false;

if (basePortInUse && (await isOurServer(requestedPort))) {
  reuseExistingBackend = true;
  console.log(`[dev] Backend existente detectado em http://localhost:${backendPort}.`);
} else if (basePortInUse) {
  backendPort = await findFreePort(requestedPort + 1);
  console.log(
    `[dev] Porta ${requestedPort} ocupada por outro processo. Backend sera iniciado em http://localhost:${backendPort}.`,
  );
} else {
  console.log(`[dev] Backend sera iniciado em http://localhost:${backendPort}.`);
}

const sharedEnv = {
  ...process.env,
  PORT: String(backendPort),
  VITE_API_BASE_URL: `http://localhost:${backendPort}`,
  VITE_PORT: String(requestedClientPort),
};

const clientPortInUse = await canConnect(requestedClientPort);
let clientPort = requestedClientPort;
let reuseExistingClient = false;

if (clientPortInUse && (await isOurClient(requestedClientPort))) {
  reuseExistingClient = true;
  console.log(`[dev] Frontend existente detectado em http://localhost:${clientPort}.`);
} else if (clientPortInUse) {
  clientPort = await findFreePort(requestedClientPort + 1);
  console.log(
    `[dev] Porta ${requestedClientPort} ocupada por outro processo. Frontend sera iniciado em http://localhost:${clientPort}.`,
  );
}

const childEnv = {
  ...sharedEnv,
  VITE_PORT: String(clientPort),
};

if (!reuseExistingBackend) {
  spawnTask("server", ["run", "dev", "--workspace", "server"], childEnv);
}

if (!reuseExistingClient) {
  spawnTask("client", ["run", "dev", "--workspace", "client"], childEnv);
}

if (reuseExistingBackend && reuseExistingClient) {
  console.log("[dev] Frontend e backend ja estavam ativos. Reutilizando as instancias existentes.");
}
