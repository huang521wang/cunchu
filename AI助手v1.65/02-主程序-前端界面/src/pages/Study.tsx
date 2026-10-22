import { useMemo, useState } from 'react';
import { useStore } from '../store/StoreContext';
import { fmtCN, fmtMD, today } from '../lib/date';
import type { StudyItem } from '../types';
import { EmptyState, Modal, Toast } from '../components/common';
import RecordingBox from '../components/RecordingBox';
import XxtCard from '../components/XxtCard';
import { parseStudyText } from '../lib/parseStudy';
import type { ParsedStudy } from '../lib/parseStudy';

const KINDS: StudyItem['kind'][] = ['作业', '考试', '复习', '其他'];
const KIND_ICON: Record<StudyItem['kind'], string> = { 作业: '📝', 考试: '📄', 复习: '🔁', 其他: '📌' };

export default function Study() {
  const { data, create, update, remove } = useStore();
  const t = today();

  const [title, setTitle] = useState('');
  const [course, setCourse] = useState('');
  const [kind, setKind] = useState<StudyItem['kind']>('作业');
  const [due, setDue] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [preview, setPreview] = useState<ParsedStudy[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const items = useMemo(
    () => [...data.studyItems].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
    [data.studyItems],
  );
  const doing = items.filter((x) => !x.done);
  const doneItems = items.filter((x) => x.done);
  const dueToday = doing.filter((x) => x.due === t).length;
  const late = doing.filter((x) => x.due && x.due < t).length;
  const sortedDoing = [...doing].sort((a, b) => {
    const ad = a.due || '9999-99-99';
    const bd = b.due || '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return (a.seq ?? 0) - (b.seq ?? 0);
  });

  const addItem = async () => {
    const text = title.trim();
    if (!text) return;
    // 先清空表单再写入，快速输入不会丢
    setTitle('');
    setCourse('');
    setDue('');
    await create('studyItems', {
      title: text,
      course: course.trim(),
      kind,
      due,
      done: false,
      doneAt: null,
    });
  };

  const toggleDone = (item: StudyItem) =>
    update('studyItems', item.id, {
      done: !item.done,
      doneAt: !item.done ? new Date().toISOString() : null,
    });

  const saveEdit = async (id: string) => {
    const text = editText.trim();
    setEditId(null);
    if (text) await update('studyItems', id, { title: text });
  };

  const runParse = () => setPreview(parseStudyText(importText, t));

  const confirmImport = async () => {
    if (!preview || preview.length === 0) return;
    let n = 0;
    for (const p of preview) {
      await create('studyItems', {
        title: p.title,
        course: p.course,
        kind: p.kind,
        due: p.due,
        done: false,
        doneAt: null,
      });
      n++;
    }
    setImportOpen(false);
    setPreview(null);
    setImportText('');
    setToast(`✓ 已导入 ${n} 条学习任务`);
  };

  const row = (item: StudyItem) => {
    const lateFlag = !item.done && !!item.due && item.due < t;
    const isToday = !item.done && item.due === t;
    return (
      <div
        className={`list-row study-item${item.done ? ' done' : ''}`}
        data-testid={`study-row-${item.id}`}
        key={item.id}
      >
        <button
          type="button"
          className={`checkbox${item.done ? ' checked' : ''}`}
          aria-label="完成"
          data-testid={`study-check-${item.id}`}
          onClick={() => toggleDone(item)}
        >
          {item.done ? '✓' : ''}
        </button>
        <span className="chip chip-gray">
          {KIND_ICON[item.kind]} {item.kind}
        </span>
        {item.course ? (
          <span className="chip chip-blue" data-testid={`study-course-${item.id}`}>
            {item.course}
          </span>
        ) : null}
        {editId === item.id ? (
          <input
            className="input grow"
            autoFocus
            data-testid={`study-edit-input-${item.id}`}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveEdit(item.id);
              if (e.key === 'Escape') setEditId(null);
            }}
            onBlur={() => saveEdit(item.id)}
          />
        ) : (
          <span className="text grow study-title" data-testid={`study-title-${item.id}`}>
            {item.title}
          </span>
        )}
        {item.due ? (
          <span
            className={`row-sub${lateFlag ? ' late' : ''}${isToday ? ' due-today' : ''}`}
            data-testid={`study-due-${item.id}`}
          >
            {lateFlag ? `已过期 ${fmtMD(item.due)}` : isToday ? '今天截止' : `截止 ${fmtMD(item.due)}`}
          </span>
        ) : null}
        <div className="hover-actions">
          <button
            type="button"
            className="icon-btn"
            title="编辑"
            data-testid={`study-edit-${item.id}`}
            onClick={() => {
              setEditId(item.id);
              setEditText(item.title);
            }}
          >
            ✎
          </button>
          <button
            type="button"
            className="icon-btn"
            title="删除"
            data-testid={`study-del-${item.id}`}
            onClick={() => remove('studyItems', item.id)}
          >
            ✕
          </button>
        </div>
      </div>
    );
  };

  return (
    <section className="page" data-testid="page-study">
      <div className="page-head">
        <h1 className="page-title">学习计划 📚</h1>
        <div className="page-sub">{fmtCN(t)} · 作业、考试都放在这里，本机保存</div>
      </div>

      <div className="stack">
        <XxtCard />
        <div className="card">
          <div className="card-head">
            <span className="card-title">作业与考试</span>
            <span className="chip chip-pink" data-testid="study-stat-doing">
              进行中 {doing.length}
            </span>
            <span className="chip chip-blue" data-testid="study-stat-today">
              今天 {dueToday}
            </span>
            {late > 0 && (
              <span className="chip chip-gray" data-testid="study-stat-late">
                已过期 {late}
              </span>
            )}
            <div className="grow" />
            <a
              className="link-more"
              href="https://i.chaoxing.com"
              target="_blank"
              rel="noreferrer"
              data-testid="study-open-site"
              title="在浏览器里打开学习通（只是打开官网，不连接任何数据）"
            >
              打开学习通 ↗
            </a>
            <button
              type="button"
              className="btn btn-blue btn-sm"
              data-testid="study-import-open"
              onClick={() => setImportOpen(true)}
            >
              📥 粘贴导入
            </button>
          </div>

          <div className="input-row" style={{ marginTop: 4 }}>
            <input
              className="input grow"
              placeholder="作业/考试内容，回车添加"
              data-testid="study-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addItem();
              }}
            />
            <input
              className="input"
              style={{ maxWidth: 110 }}
              placeholder="科目"
              data-testid="study-course-input"
              value={course}
              onChange={(e) => setCourse(e.target.value)}
            />
            <select
              className="input"
              style={{ maxWidth: 96 }}
              data-testid="study-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as StudyItem['kind'])}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input
              type="date"
              className="input"
              style={{ maxWidth: 150 }}
              data-testid="study-due"
              title="截止日期（可空）"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
            <button type="button" className="btn btn-primary" data-testid="study-add" onClick={addItem}>
              添加
            </button>
          </div>

          <div className="list" data-testid="study-list">
            {items.length === 0 && (
              <div data-testid="study-empty">
                <EmptyState
                  text="还没有学习任务：上面加一条，或点「📥 粘贴导入」把复制来的作业贴进来"
                  icon="📚"
                />
              </div>
            )}
            {sortedDoing.map((x) => row(x))}
          </div>

          {doneItems.length > 0 && (
            <div data-testid="study-done-group">
              <button
                type="button"
                className="group-label"
                data-testid="study-done-toggle"
                onClick={() => setShowDone(!showDone)}
              >
                {showDone ? '▾' : '▸'} 已完成 {doneItems.length}
              </button>
              {showDone && <div className="list">{doneItems.map((x) => row(x))}</div>}
            </div>
          )}
        </div>

        <RecordingBox />

        <div className="card">
          <div className="card-head">
            <span className="card-title">为什么是"复制粘贴"而不是直接连账号</span>
          </div>
          <div className="row-sub" style={{ lineHeight: 2 }}>
            学习通没有面向个人的官方接口；第三方"接口库"都是逆向破解的，要交出账号密码、违反用户协议、随时可能封号——
            所以工作台<b>不碰你的账号、不抓取任何数据</b>。
            <br />
            这里只做本地整理：你从官方页面自己复制内容 → 粘贴导入（支持"明天/下周一/10月25日/2026-10-25"这类日期）→
            存到你自己的电脑里。加上 AI 助手也可以直接说「加作业：下周一 高数第三章」。
          </div>
        </div>
      </div>

      <Modal
        open={importOpen}
        title="📥 粘贴导入"
        onClose={() => {
          setImportOpen(false);
          setPreview(null);
        }}
        testid="study-import"
      >
        <div className="row-sub" style={{ lineHeight: 1.9, marginBottom: 8 }}>
          从学习通（或老师发的通知）里<b>自己复制</b>文字贴进来，本地解析成任务。每行一条；
          想标科目可以写「【高数】…」或「高数|习题|10-25」。
        </div>
        <textarea
          className="input"
          style={{ minHeight: 120, resize: 'vertical', fontFamily: 'inherit' }}
          placeholder={'【高等数学】第三章课后习题 截止：明天 23:59\n大学英语|背诵 Unit 5 单词|10月25日\n期中考试 11月5日'}
          data-testid="study-import-text"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
        />
        <div className="input-row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn btn-blue btn-sm"
            data-testid="study-import-parse"
            onClick={runParse}
            disabled={!importText.trim()}
          >
            解析预览
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="study-import-confirm"
            onClick={confirmImport}
            disabled={!preview || preview.length === 0}
          >
            导入 {preview ? preview.length : 0} 条
          </button>
        </div>
        {preview && (
          <div className="list" data-testid="study-import-preview" style={{ marginTop: 8 }}>
            {preview.length === 0 && <div className="row-sub">没有解析出内容，检查一下每行是不是有文字。</div>}
            {preview.map((p, i) => (
              <div className="list-row" key={i} data-testid={`study-preview-${i}`}>
                <span className="chip chip-gray">
                  {KIND_ICON[p.kind]} {p.kind}
                </span>
                {p.course ? <span className="chip chip-blue">{p.course}</span> : null}
                <span className="text grow">{p.title}</span>
                <span className="row-sub">{p.due ? `截止 ${fmtMD(p.due)}` : '无日期'}</span>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {toast && <Toast message={toast} onClose={() => setToast(null)} testid="study-toast" />}
    </section>
  );
}
