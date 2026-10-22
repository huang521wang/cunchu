import { useEffect, useState } from 'react';
import { useStore } from '../store/StoreContext';
import { today } from '../lib/date';
import type { Task } from '../types';
import { Modal } from './common';

export interface PlanValue {
  title: string;
  date: string;
  time: string;
  estimate: string;
  note: string;
  priority: Task['priority'];
}

export function emptyPlan(date: string): PlanValue {
  return { title: '', date, time: '', estimate: '', note: '', priority: 'none' };
}

/**
 * ✨ 一键计划：项目名称 / 日期 / 时间 / 预计时间 / 备注
 * 新建和修改共用这一个表单
 */
export default function PlanModal({
  open,
  editing,
  defaultDate,
  initial,
  onClose,
  onCreated,
}: {
  open: boolean;
  editing?: Task | null;
  defaultDate?: string;
  initial?: Partial<PlanValue>;
  onClose: () => void;
  onCreated?: (task: any) => void;
}) {
  const { create, update } = useStore();
  const [form, setForm] = useState<PlanValue>(emptyPlan(defaultDate ?? today()));

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        title: editing.title,
        date: editing.date,
        time: editing.time ?? '',
        estimate: editing.estimate ?? '',
        note: editing.note ?? '',
        priority: editing.priority,
      });
    } else {
      setForm({ ...emptyPlan(defaultDate ?? today()), ...initial });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  const save = async () => {
    const title = form.title.trim();
    if (!title) return;
    const payload = {
      title,
      date: form.date || today(),
      time: form.time,
      estimate: form.estimate.trim(),
      note: form.note.trim(),
      priority: form.priority,
    };
    if (editing) {
      await update('tasks', editing.id, payload);
      onClose();
    } else {
      const created = await create('tasks', { ...payload, done: false, doneAt: null });
      onCreated?.(created);
      onClose();
    }
  };

  return (
    <Modal open={open} title={editing ? '编辑计划' : '✨ 一键计划'} onClose={onClose} testid="plan-modal">
      <div className="field">
        <label className="field-label">项目名称</label>
        <input
          className="input"
          autoFocus
          placeholder="要做什么…"
          data-testid="plan-title"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
        />
      </div>
      <div className="input-row" style={{ alignItems: 'flex-start' }}>
        <div className="field grow">
          <label className="field-label">日期</label>
          <input
            type="date"
            className="input"
            data-testid="plan-date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
          />
        </div>
        <div className="field grow">
          <label className="field-label">时间</label>
          <input
            type="time"
            className="input"
            data-testid="plan-time"
            value={form.time}
            onChange={(e) => setForm({ ...form, time: e.target.value })}
          />
        </div>
        <div className="field grow">
          <label className="field-label">预计时间</label>
          <input
            className="input"
            placeholder="比如 1 小时"
            data-testid="plan-estimate"
            value={form.estimate}
            onChange={(e) => setForm({ ...form, estimate: e.target.value })}
          />
        </div>
      </div>
      <div className="field">
        <label className="field-label">备注</label>
        <input
          className="input"
          placeholder="补充点细节（选填）"
          data-testid="plan-note"
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />
      </div>
      <div className="field">
        <label className="field-label">优先级</label>
        <select
          className="input"
          data-testid="plan-priority"
          value={form.priority}
          onChange={(e) => setForm({ ...form, priority: e.target.value as Task['priority'] })}
        >
          <option value="none">无</option>
          <option value="mid">中</option>
          <option value="high">高</option>
        </select>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn-primary" data-testid="plan-save" onClick={save}>
          保存
        </button>
      </div>
    </Modal>
  );
}
