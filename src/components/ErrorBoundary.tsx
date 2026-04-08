import * as React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null
    };
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
          <div className="max-w-md w-full bg-white p-10 rounded-[2.5rem] shadow-xl text-center space-y-6 border border-red-100">
            <div className="w-20 h-20 bg-red-50 rounded-2xl mx-auto flex items-center justify-center">
              <AlertCircle className="w-10 h-10 text-red-500" />
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-bold text-slate-900">出错了</h1>
              <p className="text-slate-500 text-sm">
                应用遇到了一个意外错误。这可能是由于浏览器兼容性或网络问题引起的。
              </p>
              {this.state.error && (
                <div className="mt-4 p-3 bg-slate-50 rounded-xl text-xs font-mono text-slate-400 break-all text-left overflow-auto max-h-32">
                  {this.state.error.message}
                </div>
              )}
            </div>
            <button 
              onClick={() => window.location.reload()}
              className="w-full py-4 bg-slate-900 text-white rounded-2xl font-semibold hover:bg-slate-800 transition-all flex items-center justify-center gap-3 active:scale-95"
            >
              <RefreshCw className="w-5 h-5" />
              重新加载应用
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
