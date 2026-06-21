import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

// B1-前端修复：全局 ErrorBoundary，避免渲染异常导致白屏
export default class ErrorBoundary extends Component<Props, State> {
  declare state: State;
  declare props: Props;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  handleReset = () => {
    (this as any).setState({ hasError: false, error: null });
  };

  handleHome = () => {
    window.location.hash = '#/';
    (this as any).setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex flex-col items-center justify-center min-h-[400px] p-8 bg-canvas-dark">
          <AlertTriangle className="w-12 h-12 text-trading-down mb-4" />
          <h2 className="text-[18px] font-bold text-white mb-2">页面渲染出错</h2>
          <p className="text-[13px] text-muted mb-1 text-center max-w-md">
            {this.state.error?.message || '发生了未知错误'}
          </p>
          <div className="flex gap-3 mt-6">
            <button
              onClick={this.handleReset}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-ink text-[13px] font-medium hover:opacity-90 transition-opacity"
            >
              <RefreshCw className="w-4 h-4" /> 重试
            </button>
            <button
              onClick={this.handleHome}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-elevated-dark text-muted text-[13px] font-medium border border-hairline-dark hover:text-white transition-colors"
            >
              <Home className="w-4 h-4" /> 回到首页
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
