import React from 'react';
import ReactDOM from 'react-dom';

type PreflightErrorModalProps = {
  isOpen: boolean;
  title?: string;
  message: string;
  onConfirm: () => void;
};

export default function PreflightErrorModal({
  isOpen,
  title = 'Request failed',
  message,
  onConfirm,
}: PreflightErrorModalProps) {
  if (!isOpen) {
    return null;
  }

  return ReactDOM.createPortal(
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl max-w-md w-full overflow-hidden">
        <div className="p-6">
          <h3 className="text-lg font-semibold text-foreground mb-2">{title}</h3>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{message}</p>
        </div>
        <div className="flex gap-3 p-4 bg-muted/30 border-t border-border">
          <button
            type="button"
            className="flex-1 inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/50 transition-colors"
            onClick={onConfirm}
          >
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

