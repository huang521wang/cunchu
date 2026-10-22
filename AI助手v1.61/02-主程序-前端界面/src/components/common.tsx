import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export function EmptyState({ text, icon = '🌸', testid }: { text: string; icon?: string; testid?: string }) {
  return (
    <div className="empty" data-testid={testid}>
      <div className="empty-icon">{icon}</div>
      <div>{text}</div>
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  testid = 'modal',
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  testid?: string;
}) {
  if (!open) return null;
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" data-testid={testid} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

export function SlidePanel({
  open,
  title,
  onClose,
  children,
  testid = 'slide-panel',
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  testid?: string;
}) {
  if (!open) return null;
  return (
    <>
      <div className="panel-mask" onClick={onClose} />
      <div className="panel" data-testid={testid}>
        <div className="panel-head">
          <div className="panel-title">{title}</div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} data-testid="panel-close">
            关闭
          </button>
        </div>
        <div className="panel-body">{children}</div>
      </div>
    </>
  );
}

export function Confirm({
  open,
  title = '确定删除吗？',
  text,
  okText = '确定删除',
  onOk,
  onCancel,
}: {
  open: boolean;
  title?: string;
  text?: string;
  okText?: string;
  onOk: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} title={title} onClose={onCancel} testid="confirm-dialog">
      {text && <div className="confirm-text">{text}</div>}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel} data-testid="confirm-cancel">
          取消
        </button>
        <button type="button" className="btn btn-danger" onClick={onOk} data-testid="confirm-ok">
          {okText}
        </button>
      </div>
    </Modal>
  );
}

export function Toast({
  message,
  actionLabel,
  onAction,
  onClose,
  testid = 'toast',
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onClose: () => void;
  testid?: string;
}) {
  useEffect(() => {
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [message, onClose]);
  return (
    <div className="toast" data-testid={testid}>
      <span>{message}</span>
      {actionLabel && onAction && (
        <button type="button" className="btn btn-sm" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/** 输入框回车提交的小工具 */
export function useEnter(onEnter: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onEnter();
    }
  };
}

/** 确认删除用的小状态机：点击删除后弹出确认框 */
export function useConfirm() {
  const [pending, setPending] = useState<null | (() => void)>(null);
  return {
    ask: (fn: () => void) => setPending(() => fn),
    dialog: (
      <Confirm
        open={pending !== null}
        onOk={() => {
          pending?.();
          setPending(null);
        }}
        onCancel={() => setPending(null)}
      />
    ),
  };
}
