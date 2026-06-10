import { startTransition, useEffect, useState } from "react";
import { io } from "socket.io-client";

const normalizeBaseUrl = (value) => String(value ?? "").trim().replace(/\/$/, "");

const runtimeApiBaseUrl =
  window.DISPARO_CONFIG?.apiBaseUrl || window.DISPARO_API_BASE_URL || "";
const apiBaseUrl = normalizeBaseUrl(runtimeApiBaseUrl || import.meta.env.VITE_API_BASE_URL);
const apiDisplayUrl = apiBaseUrl || window.location.origin;
const offlineServerMessage = `Nao foi possivel conectar ao servidor em ${apiDisplayUrl}. Verifique se o backend esta rodando.`;
const missingBackendMessage = `O backend nao respondeu em ${apiDisplayUrl}. Confira se o servidor foi publicado e se a URL da API esta configurada.`;

const socket = io(apiBaseUrl || undefined, {
  autoConnect: false,
});

const initialSessionState = {
  status: "loading",
  qrCode: null,
  phoneNumber: null,
  connectionState: null,
  lastDisconnectReason: null,
  disconnectedByPhone: false,
  lastError: null,
  lastUpdatedAt: null,
};

const initialDispatchState = {
  inProgress: false,
  total: 0,
  processed: 0,
  successCount: 0,
  failedCount: 0,
  items: [],
  startedAt: null,
  finishedAt: null,
};

const statusLabels = {
  loading: "Carregando",
  idle: "Desconectado",
  initializing: "Abrindo sessao",
  qr: "Escaneie o QR code",
  authenticated: "Autenticado",
  ready: "Conectado",
  unpaired: "Conexao removida no celular",
  disconnected: "Desconectado",
  auth_failure: "Falha na autenticacao",
  error: "Erro na conexao",
};

const phoneHints = ["telefone", "phone", "celular", "whatsapp", "contato", "numero"];
const nameHints = ["nome", "name", "cliente"];
const notesHints = ["observacao", "obs", "nota", "notes"];

const normalizeDigits = (value, defaultCountryCode = "55") => {
  let digits = String(value ?? "").replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (defaultCountryCode && digits.length >= 10 && digits.length <= 11) {
    digits = `${defaultCountryCode}${digits}`;
  }

  return digits;
};

const detectPhoneColumn = (rows) => {
  const headerRow = rows[0] ?? [];
  const normalizedHeader = headerRow.map((cell) =>
    String(cell ?? "")
      .trim()
      .toLowerCase(),
  );

  const hintedIndex = normalizedHeader.findIndex((header) =>
    phoneHints.some((hint) => header.includes(hint)),
  );

  if (hintedIndex >= 0) {
    return {
      index: hintedIndex,
      headerDetected: true,
    };
  }

  const sampleRows = rows.slice(0, 6);
  const maxColumns = sampleRows.reduce((largest, row) => Math.max(largest, row.length), 1);
  let winner = {
    index: 0,
    score: -1,
  };

  for (let column = 0; column < maxColumns; column += 1) {
    let score = 0;

    for (const row of sampleRows) {
      const digits = String(row[column] ?? "").replace(/\D/g, "");
      if (digits.length >= 10) {
        score += 1;
      }
    }

    if (score > winner.score) {
      winner = { index: column, score };
    }
  }

  return {
    index: winner.index,
    headerDetected: false,
  };
};

const detectColumnByHints = (headerRow, hints) => {
  const normalizedHeader = headerRow.map((cell) =>
    String(cell ?? "")
      .trim()
      .toLowerCase(),
  );

  return normalizedHeader.findIndex((header) =>
    hints.some((hint) => header.includes(hint)),
  );
};

const extractContacts = (rows, defaultCountryCode) => {
  if (!rows.length) {
    return {
      numbers: [],
      contacts: [],
      columnIndex: 0,
      headerDetected: false,
    };
  }

  const column = detectPhoneColumn(rows);
  const startRow = column.headerDetected ? 1 : 0;
  const headerRow = rows[0] ?? [];
  const nameColumnIndex = column.headerDetected ? detectColumnByHints(headerRow, nameHints) : -1;
  const notesColumnIndex = column.headerDetected ? detectColumnByHints(headerRow, notesHints) : -1;
  const seen = new Set();
  const numbers = [];
  const contacts = [];

  for (const row of rows.slice(startRow)) {
    const normalized = normalizeDigits(row[column.index], defaultCountryCode);

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    numbers.push(normalized);
    contacts.push({
      name:
        nameColumnIndex >= 0 && nameColumnIndex !== column.index
          ? String(row[nameColumnIndex] ?? "").trim()
          : "",
      phone: String(row[column.index] ?? "").trim(),
      normalizedPhone: normalized,
      notes:
        notesColumnIndex >= 0 && notesColumnIndex !== column.index
          ? String(row[notesColumnIndex] ?? "").trim()
          : "",
    });
  }

  return {
    numbers,
    contacts,
    columnIndex: column.index,
    headerDetected: column.headerDetected,
  };
};

const formatDateTime = (value) => {
  if (!value) {
    return "Agora";
  }

  return new Date(value).toLocaleString("pt-BR");
};

const loadSpreadsheetRows = async (file) => {
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith(".csv")) {
    const { default: Papa } = await import("papaparse");

    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        skipEmptyLines: true,
        complete: ({ data }) => resolve(data),
        error: () => reject(new Error("Nao foi possivel ler o arquivo CSV.")),
      });
    });
  }

  if (lowerName.endsWith(".xlsx")) {
    const { default: readXlsxFile } = await import("read-excel-file");
    return readXlsxFile(file);
  }

  throw new Error("Formato nao suportado. Use um arquivo .xlsx ou .csv.");
};

const toUserErrorMessage = (error, fallback = "Nao foi possivel concluir a operacao.") => {
  if (error instanceof Error) {
    if (error.message === "Failed to fetch") {
      return offlineServerMessage;
    }

    return error.message || fallback;
  }

  return fallback;
};

const request = async (path, options = {}) => {
  let response;

  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      headers: {
        "Content-Type": "application/json",
      },
      ...options,
    });
  } catch {
    throw new Error(offlineServerMessage);
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));

    if (response.status === 404 && path.startsWith("/api/")) {
      throw new Error(data.message || missingBackendMessage);
    }

    throw new Error(data.message || "Nao foi possivel concluir a operacao.");
  }

  return response.json();
};

export default function App() {
  const [session, setSession] = useState(initialSessionState);
  const [dispatchState, setDispatchState] = useState(initialDispatchState);
  const [activeTab, setActiveTab] = useState("disparo"); // "disparo" | "direto"
  const [message, setMessage] = useState(
    "Ola! Esta e uma mensagem enviada pela plataforma. Se precisar responder, fique a vontade.",
  );
  const [countryCode, setCountryCode] = useState("55");
  const [intervalMs, setIntervalMs] = useState(2500);
  const [contacts, setContacts] = useState([]);
  const [numbers, setNumbers] = useState([]);
  const [sheetMeta, setSheetMeta] = useState(null);
  const [feedback, setFeedback] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [busyAction, setBusyAction] = useState("");

  // Estado para envio direto
  const [directNumber, setDirectNumber] = useState("");
  const [directMessage, setDirectMessage] = useState(
    "Ola! Esta e uma mensagem direta enviada pela plataforma.",
  );
  const [directFeedback, setDirectFeedback] = useState(null); // { status: "sent"|"error", text: string }
  const [directBusy, setDirectBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let retryId = null;

    const syncSession = (data) => {
      setErrorMessage("");
      setSession(data);
    };

    const syncDispatch = (data) => {
      setErrorMessage("");
      setDispatchState(data);
    };

    socket.on("session-state", syncSession);
    socket.on("dispatch-state", syncDispatch);
    socket.on("connect", () => {
      setErrorMessage("");
    });

    const loadHealth = async () => {
      try {
        const data = await request("/api/health");

        if (cancelled) {
          return;
        }

        setSession(data.session);
        setDispatchState(data.dispatch);
        setErrorMessage("");

        if (!socket.connected) {
          socket.connect();
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        setErrorMessage(toUserErrorMessage(error));
        retryId = window.setTimeout(loadHealth, 2000);
      }
    };

    loadHealth();

    return () => {
      cancelled = true;
      if (retryId) {
        window.clearTimeout(retryId);
      }
      socket.off("session-state", syncSession);
      socket.off("dispatch-state", syncDispatch);
      socket.off("connect");
      socket.disconnect();
    };
  }, []);

  const handleStartSession = async () => {
    setBusyAction("session");
    setErrorMessage("");
    setFeedback("");

    try {
      await request("/api/session/start", {
        method: "POST",
      });
      setFeedback("Sessao iniciada. Escaneie o QR code assim que ele aparecer.");
    } catch (error) {
      setErrorMessage(toUserErrorMessage(error));
    } finally {
      setBusyAction("");
    }
  };

  const handleLogout = async () => {
    setBusyAction("logout");
    setErrorMessage("");
    setFeedback("");

    try {
      await request("/api/session/logout", {
        method: "POST",
      });
      setFeedback("Sessao desconectada com sucesso.");
    } catch (error) {
      setErrorMessage(toUserErrorMessage(error));
    } finally {
      setBusyAction("");
    }
  };

  const handleSpreadsheetImport = async (event) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setErrorMessage("");
    setFeedback("");

    try {
      const rows = await loadSpreadsheetRows(file);
      const extracted = extractContacts(rows, countryCode);

      startTransition(() => {
        setContacts(extracted.contacts);
        setNumbers(extracted.numbers);
        setSheetMeta({
          fileName: file.name,
          totalRows: rows.length,
          extractedCount: extracted.numbers.length,
          columnIndex: extracted.columnIndex,
          headerDetected: extracted.headerDetected,
        });
      });

      setFeedback(`${extracted.numbers.length} numeros foram carregados da planilha.`);
    } catch {
      setErrorMessage("Nao foi possivel ler a planilha. Verifique se o arquivo e valido.");
    } finally {
      event.target.value = "";
    }
  };

  const handleSendMessages = async () => {
    setBusyAction("dispatch");
    setErrorMessage("");
    setFeedback("");

    try {
      const result = await request("/api/messages/send", {
        method: "POST",
        body: JSON.stringify({
          numbers,
          message,
          defaultCountryCode: countryCode,
          intervalMs,
        }),
      });

      setFeedback(
        `Disparo concluido: ${result.successCount} enviados e ${result.failedCount} falhas.`,
      );
    } catch (error) {
      setErrorMessage(toUserErrorMessage(error));
    } finally {
      setBusyAction("");
    }
  };

  const handleSendDirect = async () => {
    setDirectBusy(true);
    setDirectFeedback(null);

    try {
      await request("/api/messages/send-single", {
        method: "POST",
        body: JSON.stringify({
          number: directNumber,
          message: directMessage,
          defaultCountryCode: countryCode,
        }),
      });
      setDirectFeedback({
        status: "sent",
        text: `Mensagem enviada com sucesso para ${directNumber}.`,
      });
    } catch (error) {
      setDirectFeedback({
        status: "error",
        text: toUserErrorMessage(error),
      });
    } finally {
      setDirectBusy(false);
    }
  };

  const progress = dispatchState.total
    ? Math.round((dispatchState.processed / dispatchState.total) * 100)
    : 0;
  const isConnected = session.status === "ready";
  const shouldShowReconnectCopy = session.status === "unpaired" || session.disconnectedByPhone;
  const canSend = isConnected && numbers.length > 0 && message.trim() && !dispatchState.inProgress;
  const canSendDirect =
    isConnected && directNumber.trim() && directMessage.trim() && !directBusy;

  return (
    <main className="page-shell">
      <div className="background-orb background-orb--left" />
      <div className="background-orb background-orb--right" />

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Plataforma React + WhatsApp Web</span>
          <h1>Conecte por QR code e dispare mensagens em poucos passos.</h1>
          <p>
            A tela centraliza toda a operacao: autenticar o WhatsApp, enviar para um numero
            especifico ou disparar para uma lista inteira.
          </p>
        </div>

        <div className="status-panel">
          <div className="status-header">
            <span className={`status-dot status-dot--${session.status}`} />
            <div>
              <strong>{statusLabels[session.status] || "Status desconhecido"}</strong>
              <p>
                {session.phoneNumber
                  ? `Conta conectada: ${session.phoneNumber}`
                  : shouldShowReconnectCopy
                    ? "A conexao foi removida no celular. Gere um novo QR code para reconectar."
                    : "Nenhuma conta conectada no momento."}
              </p>
            </div>
          </div>

          <div className="status-actions">
            <button
              type="button"
              className="button button--primary"
              onClick={handleStartSession}
              disabled={busyAction === "session" || dispatchState.inProgress}
            >
              {busyAction === "session"
                ? "Abrindo..."
                : shouldShowReconnectCopy
                  ? "Gerar novo QR code"
                  : "Gerar QR code"}
            </button>

            <button
              type="button"
              className="button button--ghost"
              onClick={handleLogout}
              disabled={busyAction === "logout" || dispatchState.inProgress}
            >
              {busyAction === "logout" ? "Saindo..." : "Desconectar"}
            </button>
          </div>

          {session.lastError && <p className="status-error">{session.lastError}</p>}
          {session.connectionState && (
            <small>Estado atual do WhatsApp Web: {session.connectionState}</small>
          )}
          <small>Ultima atualizacao: {formatDateTime(session.lastUpdatedAt)}</small>
        </div>
      </section>

      {(feedback || errorMessage) && (
        <section className="feedback-strip">
          {feedback && <p className="feedback feedback--success">{feedback}</p>}
          {errorMessage && <p className="feedback feedback--error">{errorMessage}</p>}
        </section>
      )}

      <section className="dashboard-grid">
        <article className="panel panel--qr">
          <div className="panel-heading">
            <span className="panel-kicker">1. Conexao</span>
            <h2>QR code do WhatsApp</h2>
          </div>

          {session.qrCode ? (
            <div className="qr-wrapper">
              <img src={session.qrCode} alt="QR code para conectar o WhatsApp" />
            </div>
          ) : (
            <div className="empty-state">
              <strong>
                {isConnected
                  ? "WhatsApp conectado e pronto para enviar."
                  : shouldShowReconnectCopy
                    ? "A sessao foi removida no celular. Gere um novo QR code para voltar a conectar."
                    : "Clique em gerar QR code para iniciar a autenticacao."}
              </strong>
              <p>
                Se a sessao ja existir, o backend tenta restaurar a conexao automaticamente.
              </p>
            </div>
          )}
        </article>

        <article className="panel">
          <div className="panel-heading">
            <span className="panel-kicker">2. Lista de contatos</span>
            <h2>Importe seu Excel</h2>
          </div>

          <label className="file-dropzone">
            <input
              type="file"
              accept=".xlsx,.csv"
              onChange={handleSpreadsheetImport}
            />
            <span>Selecionar planilha</span>
            <small>Arquivos `.xlsx` ou `.csv`</small>
          </label>

          <div className="inline-fields">
            <label>
              Codigo do pais
              <input
                type="text"
                value={countryCode}
                onChange={(event) => setCountryCode(event.target.value.replace(/\D/g, ""))}
                placeholder="55"
              />
            </label>

            <label>
              Intervalo entre envios (ms)
              <input
                type="number"
                min="500"
                max="10000"
                step="100"
                value={intervalMs}
                onChange={(event) => setIntervalMs(Number(event.target.value || 0))}
              />
            </label>
          </div>

          <div className="metrics">
            <div>
              <strong>{numbers.length}</strong>
              <span>contatos validos</span>
            </div>
            <div>
              <strong>{sheetMeta?.fileName || "Nenhuma planilha"}</strong>
              <span>arquivo selecionado</span>
            </div>
            <div>
              <strong>{sheetMeta ? `Coluna ${sheetMeta.columnIndex + 1}` : "--"}</strong>
              <span>origem detectada</span>
            </div>
          </div>

          <div className="contact-preview">
            {numbers.length > 0 ? (
              <>
                {numbers.slice(0, 12).map((number) => (
                  <span key={number} className="contact-chip">
                    {number}
                  </span>
                ))}
                {numbers.length > 12 && (
                  <span className="contact-chip contact-chip--more">
                    +{numbers.length - 12} contatos
                  </span>
                )}
              </>
            ) : (
              <p>Nenhum numero carregado ainda.</p>
            )}
          </div>
        </article>

        {/* Painel de mensagem com abas */}
        <article className="panel panel--wide">
          <div className="panel-heading">
            <span className="panel-kicker">3. Mensagem</span>
            <h2>Compose e envie</h2>
          </div>

          <div className="tabs">
            <button
              id="tab-disparo"
              type="button"
              className={`tab-button${activeTab === "disparo" ? " tab-button--active" : ""}`}
              onClick={() => setActiveTab("disparo")}
            >
              📋 Disparo em massa
            </button>
            <button
              id="tab-direto"
              type="button"
              className={`tab-button${activeTab === "direto" ? " tab-button--active" : ""}`}
              onClick={() => setActiveTab("direto")}
            >
              ✉️ Envio direto
            </button>
          </div>

          {activeTab === "disparo" && (
            <div className="tab-content">
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Digite aqui a mensagem da campanha..."
                rows={8}
              />

              <div className="composer-footer">
                <small>
                  {message.trim().length} caracteres. Mantenha o conteudo relevante e envie apenas
                  para contatos autorizados.
                </small>

                <button
                  id="btn-iniciar-disparo"
                  type="button"
                  className="button button--accent"
                  onClick={handleSendMessages}
                  disabled={!canSend || busyAction === "dispatch"}
                >
                  {busyAction === "dispatch" || dispatchState.inProgress
                    ? "Enviando..."
                    : "Iniciar disparo"}
                </button>
              </div>
            </div>
          )}

          {activeTab === "direto" && (
            <div className="tab-content direct-send-form">
              <label className="direct-label">
                Numero de destino
                <div className="direct-number-row">
                  <span className="direct-country-badge">+{countryCode}</span>
                  <input
                    id="direct-number"
                    type="tel"
                    value={directNumber}
                    onChange={(e) => setDirectNumber(e.target.value)}
                    placeholder="(DDD) 9 XXXX-XXXX"
                    className="direct-number-input"
                  />
                </div>
              </label>

              <label className="direct-label">
                Mensagem
                <textarea
                  id="direct-message"
                  value={directMessage}
                  onChange={(e) => setDirectMessage(e.target.value)}
                  placeholder="Digite a mensagem a ser enviada..."
                  rows={6}
                />
              </label>

              {directFeedback && (
                <div
                  className={`direct-feedback direct-feedback--${directFeedback.status}`}
                >
                  {directFeedback.status === "sent" ? "✅ " : "❌ "}
                  {directFeedback.text}
                </div>
              )}

              <div className="composer-footer">
                <small>
                  {directMessage.trim().length} caracteres.{" "}
                  {!isConnected && "Conecte o WhatsApp para habilitar o envio."}
                </small>

                <button
                  id="btn-enviar-direto"
                  type="button"
                  className="button button--primary"
                  onClick={handleSendDirect}
                  disabled={!canSendDirect}
                >
                  {directBusy ? "Enviando..." : "Enviar agora"}
                </button>
              </div>
            </div>
          )}
        </article>

        {/* Progresso do disparo em massa */}
        <article className="panel panel--wide">
          <div className="panel-heading">
            <span className="panel-kicker">4. Acompanhamento</span>
            <h2>Progresso do envio</h2>
          </div>

          <div className="progress-card">
            <div className="progress-topline">
              <strong>
                {dispatchState.inProgress ? "Disparo em andamento" : "Nenhum disparo ativo"}
              </strong>
              <span>{progress}%</span>
            </div>
            <div className="progress-bar">
              <span style={{ width: `${progress}%` }} />
            </div>
            <div className="progress-stats">
              <span>Total: {dispatchState.total}</span>
              <span>Processados: {dispatchState.processed}</span>
              <span>Enviados: {dispatchState.successCount}</span>
              <span>Falhas: {dispatchState.failedCount}</span>
            </div>
          </div>

          <div className="results-list">
            {dispatchState.items.length > 0 ? (
              dispatchState.items
                .slice()
                .reverse()
                .slice(0, 12)
                .map((item) => (
                  <div key={`${item.number}-${item.sentAt}`} className="result-row">
                    <div>
                      <strong>{item.number}</strong>
                      <p>{item.detail}</p>
                    </div>
                    <span className={`result-badge result-badge--${item.status}`}>
                      {item.status === "sent" ? "Enviado" : "Falhou"}
                    </span>
                  </div>
                ))
            ) : (
              <p className="results-empty">Os resultados do disparo aparecem aqui em tempo real.</p>
            )}
          </div>
        </article>
      </section>
    </main>
  );
}
