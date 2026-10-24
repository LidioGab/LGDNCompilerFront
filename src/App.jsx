/**
 * App.jsx — Componente principal do LGDN Compiler
 *
 * Layout:
 *  - Mobile  → abas (Editor | Terminal) com tab-nav
 *  - Desktop → editor à esquerda (50%) + terminal à direita (50%)
 *
 * Fluxo:
 *  1. Usuário edita o código no Monaco Editor.
 *  2. Clica em "Executar" → abre WebSocket → envia { type:"run", code }.
 *  3. Backend roda o código num container Docker e devolve stdout/stderr.
 *  4. Xterm.js exibe o output em tempo real.
 *  5. Se o código pedir input (prompt-sync), o Xterm captura a digitação
 *     e envia { type:"input", data } de volta para o backend/Docker.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  Play,
  Square,
  Trash2,
  Code2,
  TerminalSquare,
  Cpu,
} from 'lucide-react';

// ── Constantes ──────────────────────────────────────────────────────────────
const WS_URL = import.meta.env.VITE_WS_URL;

const EXAMPLE_CODE = `import prompt from 'prompt-sync';
const ler = prompt();

const nome = ler('Qual o seu nome? ');
console.log(\`Olá, \${nome}! Bem-vindo ao LGDN Compiler. 🚀\`);
console.log("feito para voces meus alunos, com muito carinho")
`;

// Opções do Monaco Editor — tema escuro personalizado
const MONACO_OPTIONS = {
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  fontLigatures: true,
  lineHeight: 22,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: 'gutter',
  cursorBlinking: 'smooth',
  cursorSmoothCaretAnimation: 'on',
  smoothScrolling: true,
  padding: { top: 16, bottom: 16 },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: true },
};

// Opções do Xterm.js
const XTERM_OPTIONS = {
  theme: {
    background: '#0c0e13',
    foreground: '#e8eaf6',
    cursor: '#6366f1',
    cursorAccent: '#0c0e13',
    selectionBackground: 'rgba(99,102,241,0.3)',
    black: '#1a1d27',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#f59e0b',
    blue: '#6366f1',
    magenta: '#a855f7',
    cyan: '#06b6d4',
    white: '#e8eaf6',
    brightBlack: '#555875',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#fbbf24',
    brightBlue: '#818cf8',
    brightMagenta: '#c084fc',
    brightCyan: '#22d3ee',
    brightWhite: '#f1f5f9',
  },
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  fontSize: 13,
  lineHeight: 1.5,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 3000,
  convertEol: true,
  allowProposedApi: true,
};

// ── Componente principal ─────────────────────────────────────────────────────
export default function App() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [code, setCode] = useState(EXAMPLE_CODE);
  const [activeTab, setActiveTab] = useState('editor'); // 'editor' | 'terminal'
  const [status, setStatus] = useState('idle');     // 'idle' | 'running' | 'error'
  const [statusMsg, setStatusMsg] = useState('Pronto');

  // ── Refs ───────────────────────────────────────────────────────────────────
  const terminalRef = useRef(null);  // div que hospeda o Xterm
  const xtermRef = useRef(null);  // instância do Terminal
  const fitAddonRef = useRef(null);  // instância do FitAddon
  const wsRef = useRef(null);  // WebSocket ativo
  const inputBufRef = useRef('');    // buffer de input digitado no terminal

  // ── Inicializa Xterm.js ────────────────────────────────────────────────────
  useEffect(() => {
    // Evita dupla inicialização no StrictMode
    if (xtermRef.current) return;

    const term = new Terminal(XTERM_OPTIONS);
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    if (terminalRef.current) {
      term.open(terminalRef.current);
      fitAddon.fit();
    }

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Mensagem de boas-vindas
    term.writeln('\x1b[1;34m╔══════════════════════════════════════╗\x1b[0m');
    term.writeln('\x1b[1;34m║  \x1b[1;32mLGDN Compiler \x1b[0;34m— Node.js Sandbox   \x1b[1;34m║\x1b[0m');
    term.writeln('\x1b[1;34m╚══════════════════════════════════════╝\x1b[0m');
    term.writeln('');
    term.writeln('\x1b[90mClique em \x1b[32m▶ Executar\x1b[90m para rodar seu código.\x1b[0m');
    term.writeln('');

    // Captura o que o usuário digita no terminal e envia ao processo Docker
    term.onData((data) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

      const ENTER = '\r';
      const BKSP = '\x7f';
      const CTRL_C = '\x03';

      if (data === CTRL_C) {
        // Ctrl+C: matar o processo
        wsRef.current.send(JSON.stringify({ type: 'kill' }));
        term.writeln('\x1b[31m^C\x1b[0m');
        return;
      }

      if (data === BKSP) {
        // Backspace: apaga o último caractere do buffer e do terminal
        if (inputBufRef.current.length > 0) {
          inputBufRef.current = inputBufRef.current.slice(0, -1);
          term.write('\b \b');
        }
        return;
      }

      if (data === ENTER) {
        // Enter: envia o buffer acumulado ao stdin do Docker
        const input = inputBufRef.current;
        inputBufRef.current = '';
        term.writeln('');  // nova linha no visual
        wsRef.current.send(JSON.stringify({ type: 'input', data: input }));
        return;
      }

      // Caractere normal: exibe no terminal e acumula no buffer
      inputBufRef.current += data;
      term.write(data);
    });

    // Ajusta o terminal ao redimensionar a janela
    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Reajusta o fit quando a aba do terminal fica visível no mobile
  useEffect(() => {
    if (activeTab === 'terminal' && fitAddonRef.current) {
      setTimeout(() => fitAddonRef.current?.fit(), 50);
    }
  }, [activeTab]);

  // ── Fecha o WebSocket atual (se houver) ────────────────────────────────────
  const closeWs = useCallback(() => {
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'kill' }));
      }
      wsRef.current.close();
      wsRef.current = null;
    }
    inputBufRef.current = '';
  }, []);

  // ── Executa o código ────────────────────────────────────────────────────────
  const runCode = useCallback(() => {
    const term = xtermRef.current;
    if (!term) return;

    // 1. Fecha conexão anterior e limpa o terminal
    closeWs();
    term.clear();
    inputBufRef.current = '';

    setStatus('running');
    setStatusMsg('Executando…');

    // 2. Muda para a aba do terminal no mobile
    setActiveTab('terminal');

    // 3. Abre o WebSocket
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      term.writeln(`\x1b[31m❌ Não foi possível conectar ao backend: ${err.message}\x1b[0m`);
      setStatus('error');
      setStatusMsg('Erro de conexão');
      return;
    }

    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'run', code }));
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        term.write(event.data);
        return;
      }

      switch (msg.type) {
        case 'output':
          term.write(msg.data);
          break;

        case 'error':
          // Stderr em vermelho suave
          term.write(`\x1b[91m${msg.data}\x1b[0m`);
          break;

        case 'info':
          term.write(`\x1b[90m${msg.data}\x1b[0m`);
          break;

        case 'exit':
          term.writeln(`\x1b[90m${msg.data}\x1b[0m`);
          setStatus('idle');
          setStatusMsg('Finalizado');
          wsRef.current = null;
          break;

        default:
          term.write(msg.data ?? '');
      }
    };

    ws.onerror = () => {
      term.writeln(`\x1b[31m❌ Erro de WebSocket. Verifique se o backend está rodando em ${WS_URL}\x1b[0m`);
      setStatus('error');
      setStatusMsg('Erro de WebSocket');
      wsRef.current = null;
    };

    ws.onclose = () => {
      if (status === 'running') {
        setStatus('idle');
        setStatusMsg('Pronto');
      }
      wsRef.current = null;
    };
  }, [code, closeWs, status]);

  // ── Para a execução ─────────────────────────────────────────────────────────
  const stopCode = useCallback(() => {
    closeWs();
    xtermRef.current?.writeln('\x1b[33m\n⏹  Execução interrompida pelo usuário.\x1b[0m');
    setStatus('idle');
    setStatusMsg('Parado');
  }, [closeWs]);

  // ── Limpa o terminal ────────────────────────────────────────────────────────
  const clearTerminal = useCallback(() => {
    xtermRef.current?.clear();
  }, []);

  // ── Limpeza ao desmontar ────────────────────────────────────────────────────
  useEffect(() => {
    return () => closeWs();
  }, [closeWs]);

  // ── Renderização ─────────────────────────────────────────────────────────────
  const isRunning = status === 'running';

  return (
    <div className="app">
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <header className="toolbar" role="banner">
        {/* Logo */}
        <div className="toolbar-logo">
          <div className="toolbar-logo-icon" aria-hidden="true">
            <Cpu size={16} color="#fff" strokeWidth={2.5} />
          </div>
          <span className="toolbar-logo-text">LGDN Compiler</span>
        </div>

        {/* Status */}
        <div
          className={`status-badge ${status}`}
          role="status"
          aria-live="polite"
          aria-label={`Status: ${statusMsg}`}
        >
          <div className="status-dot" aria-hidden="true" />
          {statusMsg}
        </div>

        {/* Botão Parar */}
        <button
          id="btn-stop"
          className="btn btn-stop"
          onClick={stopCode}
          disabled={!isRunning}
          aria-label="Parar execução"
          title="Parar (Ctrl+C)"
        >
          <Square size={14} strokeWidth={2.5} />
          <span className="sr-only sm-visible">Parar</span>
        </button>

        {/* Botão Executar */}
        <button
          id="btn-run"
          className="btn btn-run"
          onClick={runCode}
          disabled={isRunning}
          aria-label="Executar código"
          title="Executar"
        >
          <Play size={14} strokeWidth={2.5} />
          Executar
        </button>
      </header>

      {/* ── Tabs (mobile only) ─────────────────────────────────────────── */}
      <nav className="tab-nav" role="tablist" aria-label="Painéis">
        <button
          id="tab-editor"
          role="tab"
          className={`tab-btn ${activeTab === 'editor' ? 'active' : ''}`}
          aria-selected={activeTab === 'editor'}
          aria-controls="panel-editor"
          onClick={() => setActiveTab('editor')}
        >
          <Code2 size={15} />
          Editor
        </button>
        <button
          id="tab-terminal"
          role="tab"
          className={`tab-btn ${activeTab === 'terminal' ? 'active' : ''}`}
          aria-selected={activeTab === 'terminal'}
          aria-controls="panel-terminal"
          onClick={() => {
            setActiveTab('terminal');
            setTimeout(() => fitAddonRef.current?.fit(), 50);
          }}
        >
          <TerminalSquare size={15} />
          Terminal
          {isRunning && (
            <span className="status-dot" style={{ background: 'var(--accent-green)', boxShadow: '0 0 6px var(--accent-green)' }} aria-hidden="true" />
          )}
        </button>
      </nav>

      {/* ── Workspace ───────────────────────────────────────────────────── */}
      <main className="workspace" role="main">

        {/* ── Painel do Editor ──────────────────────────────────────────── */}
        <section
          id="panel-editor"
          role="tabpanel"
          aria-labelledby="tab-editor"
          className={`panel ${activeTab !== 'editor' ? 'hidden' : ''}`}
        >
          <div className="panel-header">
            <Code2 size={13} color="var(--text-muted)" />
            <span className="panel-title">Editor</span>
            <span className="panel-badge">JavaScript</span>
          </div>
          <div className="editor-panel">
            <Editor
              height="100%"
              defaultLanguage="javascript"
              value={code}
              onChange={(val) => setCode(val ?? '')}
              theme="vs-dark"
              options={MONACO_OPTIONS}
              loading={
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>
                  Carregando editor…
                </div>
              }
            />
          </div>
        </section>

        {/* Divisor (desktop only) */}
        <div className="panel-divider" role="separator" aria-hidden="true" />

        {/* ── Painel do Terminal ─────────────────────────────────────────── */}
        <section
          id="panel-terminal"
          role="tabpanel"
          aria-labelledby="tab-terminal"
          className={`panel ${activeTab !== 'terminal' ? 'hidden' : ''}`}
        >
          <div className="panel-header">
            <TerminalSquare size={13} color="var(--text-muted)" />
            <span className="panel-title">Terminal</span>
            {isRunning && <span className="panel-badge" style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--accent-green)', borderColor: 'rgba(34,197,94,0.25)' }}>● Live</span>}
            <button
              id="btn-clear-terminal"
              className="btn btn-clear"
              onClick={clearTerminal}
              aria-label="Limpar terminal"
              title="Limpar terminal"
              style={{ marginLeft: 'auto', padding: '3px 8px', fontSize: 11 }}
            >
              <Trash2 size={12} />
              Limpar
            </button>
          </div>
          <div className="terminal-wrapper" ref={terminalRef} aria-label="Terminal de saída" />
        </section>
      </main>
    </div>
  );
}
