import React from 'react';

type ErrorBoundaryProps = {
  children: React.ReactNode;
  fallbackMessage: string;
  reloadLabel: string;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Screen render failed', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <section className="error-boundary-fallback">
          <p>{this.props.fallbackMessage}</p>
          <button type="button" className="primary-button" onClick={this.handleReload}>
            {this.props.reloadLabel}
          </button>
        </section>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
