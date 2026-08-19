// =====================================================================
// Rete di sicurezza dell'interfaccia.
//
// Senza, un'eccezione durante il render smonta l'albero React e la
// finestra resta vuota: l'unico rimedio e' chiudere e riaprire l'app.
// Con questo, l'errore si vede, si copia e si riparte — e soprattutto
// non si perde una corsa in atto, che vive nel processo principale e
// viene ripresa dallo snapshot appena il renderer torna in piedi.
// =====================================================================

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error?: Error;
  stack?: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Interface error:', error, info.componentStack);
    this.setState({ stack: info.componentStack ?? undefined });
  }

  render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <div className="crash-inner">
          <h2>The interface stopped unexpectedly</h2>
          <p className="dim">
            Any run in progress has not been lost: it lives in the main process and will resume
            as soon as the interface restarts.
          </p>
          <div className="block">
            {error.message}
            {stack ? `\n${stack.trim()}` : ''}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button
              className="btn"
              onClick={() => void navigator.clipboard.writeText(`${error.stack ?? error.message}\n${stack ?? ''}`)}
            >
              Copia il dettaglio
            </button>
            <button className="btn primary" onClick={() => window.location.reload()}>
              Restart interface
            </button>
          </div>
        </div>
      </div>
    );
  }
}
