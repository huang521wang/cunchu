/** 记忆树的五根树枝（前端与注入提示词共用同一套分类） */
export const BRANCHES = [
  { key: 'about', label: '关于我', emoji: '🌸', color: '#E39BB7' },
  { key: 'work', label: '工作', emoji: '💼', color: '#8FA3CF' },
  { key: 'life', label: '生活', emoji: '🌿', color: '#7FC7AC' },
  { key: 'preference', label: '偏好', emoji: '✨', color: '#B3A3D9' },
  { key: 'idea', label: '灵感', emoji: '💡', color: '#E4C27A' },
  { key: 'rules', label: '永久注释', emoji: '⚠️', color: '#E8A87C' },
] as const;

export type BranchKey = (typeof BRANCHES)[number]['key'];

export const BRANCH_MAP = Object.fromEntries(BRANCHES.map((b) => [b.key, b])) as Record<
  BranchKey,
  (typeof BRANCHES)[number]
>;
