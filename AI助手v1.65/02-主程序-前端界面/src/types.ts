export interface Base {
  id: string;
  /** 服务端递增序号：同一毫秒内创建的多条记录也能稳定排序 */
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Task extends Base {
  title: string;
  date: string;
  priority: 'high' | 'mid' | 'none';
  /** 计划开始时间 HH:mm（可空） */
  time?: string;
  /** 预计用时（自由文本，如 "1 小时"，可空） */
  estimate?: string;
  /** 备注（可空） */
  note?: string;
  done: boolean;
  doneAt: string | null;
}

export interface Memo extends Base {
  text: string;
}

/** 学习计划：作业/考试等（本机手动录入或"粘贴导入"，不连接任何账号） */
export interface StudyItem extends Base {
  title: string;
  /** 科目/课程（可空） */
  course?: string;
  kind: '作业' | '考试' | '复习' | '其他';
  /** 截止日期 YYYY-MM-DD（可空） */
  due?: string;
  done: boolean;
  doneAt: string | null;
  /** 备注（可空） */
  note?: string;
}

/** AI 助手的对话记录（存在本机数据文件里，重启不丢） */
export interface ChatMessage extends Base {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  /** 消息带的图片等附件（发图时会把图片显示在气泡里，柳月虹照常能"看见"） */
  attachments?: { kind: 'image' | 'video'; name: string; mime: string; file: string }[];
  source?: string;
  personaKind?: string;
}

export interface Memory extends Base {
  /** 所属树枝：about / work / life / preference / idea */
  branch: string;
  text: string;
  pinned: boolean;
  source: 'manual' | 'chat';
  /** 强度 1~5：被再次印证会 +1，久不印证自然淡出 */
  weight?: number;
}

export interface Idea extends Base {
  text: string;
}

export interface ContentItem extends Base {
  title: string;
  platform: string;
  status: 'idea' | 'writing' | 'ready' | 'published';
  plannedDate: string;
  draft: string;
  note: string;
  link: string;
}

export interface PublishStat extends Base {
  itemId: string;
  date: string;
  reads: number;
  likes: number;
  comments: number;
}

export interface Project extends Base {
  name: string;
  status: 'active' | 'paused' | 'done';
  desc: string;
}

export interface ProjectTask extends Base {
  projectId: string;
  title: string;
  status: 'todo' | 'doing' | 'done';
  priority: 'high' | 'mid' | 'none';
  note: string;
}

export interface DevLog extends Base {
  projectId: string;
  text: string;
}

export interface Client extends Base {
  name: string;
  note: string;
}

export interface FollowUp extends Base {
  clientId: string;
  text: string;
  dueDate: string;
  done: boolean;
}

export interface CommLog extends Base {
  clientId: string;
  date: string;
  text: string;
}

export interface TimeEntry extends Base {
  clientId: string;
  date: string;
  hours: number;
  note: string;
  source: 'timer' | 'manual';
}

export interface WorkoutLog extends Base {
  date: string;
  content: string;
  note: string;
}

export interface WeightLog extends Base {
  date: string;
  weight: number;
}

export interface MealDay extends Base {
  date: string;
  breakfast: string;
  lunch: string;
  dinner: string;
  snack: string;
  water: number;
}

export interface GameItem extends Base {
  name: string;
  category: 'game' | 'movie' | 'other';
  status: 'wish' | 'playing' | 'done' | 'shelved';
  progressNote: string;
}

export interface PlayLog extends Base {
  itemId: string;
  date: string;
  hours: number;
  note: string;
}

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  platforms: string[];
  weeklyPlan: string[];
  /** 游戏周计划：周一到周日各一格 */
  gamePlan: string[];
  waterGoal: number;
  /** 本地模型服务（OpenAI 兼容接口，只连本机） */
  modelApi?: { baseUrl: string; model: string };
  /** AI 画图通道：auto=默认（有 Key 走智谱，没 Key 走零密钥云端）；zhipu/ollama 为显式指定 */
  imagineProvider?: 'auto' | 'zhipu' | 'pollinations' | 'ollama';
  /** GET 不回传原文，只回 imagineKeySet；PUT 用它写入 */
  imagineKey?: string;
  imagineKeySet?: boolean;
  imagineOllamaModel?: string;
  /** 模型列表（可多个）+ 当前激活的那个 */
  models?: ModelEntry[];
  activeModelId?: string;
  /** 她（柳月虹）的人设与状态 */
  persona?: Persona;
  /** 是否让 AI 助手在对话时带上记忆树的内容 */
  memoryEnabled?: boolean;
  /** 自动发现值得记住的话（确认后才记） */
  autoMemory?: boolean;
  /** 记忆模式：auto 静默自动记忆（只撤销）；ask 每条都要确认 */
  memoryMode?: 'auto' | 'ask';
  /** 模型协同：自动调度（日常快模型、数学逻辑推理模型、离线降级） */
  autoRoute?: boolean;
  /** 多选模型池：用户在助手页勾选的模型 id（空 = 全部可用） */
  selectedModels?: string[];
  /** 模型管家：自动启动/自动切换/自动关冲突模型 */
  autoManage?: boolean;
}

export interface AllData {
  tasks: Task[];
  memos: Memo[];
  memories: Memory[];
  chatMessages: ChatMessage[];
  studyItems: StudyItem[];
  lessonNotes: LessonNote[];
  files: Asset[];
  documents: Doc[];
  ideas: Idea[];
  contentItems: ContentItem[];
  publishStats: PublishStat[];
  projects: Project[];
  projectTasks: ProjectTask[];
  devLogs: DevLog[];
  clients: Client[];
  followUps: FollowUp[];
  commLogs: CommLog[];
  timeEntries: TimeEntry[];
  workoutLogs: WorkoutLog[];
  weightLogs: WeightLog[];
  mealDays: MealDay[];
  gameItems: GameItem[];
  playLogs: PlayLog[];
}

/** 课堂/会议录音笔记：录音文件 + 本地转写 + 本地模型总结（全部在本机） */
export interface LessonNote extends Base {
  title: string;
  course?: string;
  date: string;
  /** 秒数（0 = 未知，比如上传的文件） */
  duration: number;
  /** 相对数据目录的音频路径，如 recordings/xxx.webm */
  audioFile: string;
  status: 'recorded' | 'transcribing' | 'transcribed' | 'summarizing' | 'done' | 'failed';
  transcript: string;
  summary: string;
  error?: string;
}

/** 素材柜：图片/视频/任意文件（存在本机） */
export interface Asset extends Base {
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'video' | 'audio' | 'text' | 'other';
  /** 相对数据目录的路径，如 files/xxx.png */
  file: string;
}

/** 文档：AI 回答存下来的作品，或手写新建 */
export interface Doc extends Base {
  title: string;
  content: string;
  source: 'chat' | 'manual';
}

/** 她的一条性格特点（在相处中慢慢形成） */
export interface PersonaTrait {
  text: string;
  weight: number;
  source: 'reflect' | 'feedback' | 'manual';
  updatedAt: string;
}

/** 她的一个念头（发呆时想的，进心事本） */
export interface PersonaThought {
  at: string;
  text: string;
  mood: 'happy' | 'worry' | 'curious' | 'sleepy';
  source: 'data' | 'memory' | 'model';
}

/** 她的一场梦 */
export interface PersonaDream {
  at: string;
  text: string;
  type: '温馨' | '奇怪' | '搞笑' | '怀旧';
}

/** 她（柳月虹）：人设 + 性格档案 + 心事本 + 梦记 */
export interface Persona {
  name: string;
  addressAs: string;
  /** quiet=安静 / free=自由 / active=活泼 */
  freedom: 'quiet' | 'free' | 'active';
  traits: PersonaTrait[];
  thoughts: PersonaThought[];
  dreams: PersonaDream[];
  lastActiveAt: string;
  energy: number;
  chatsSinceReflect: number;
}

/** AI 模型条目：本机模型 /（预留）云端模型 */
export interface ModelEntry {
  id: string;
  name: string;
  type: 'local' | 'cloud';
  /** 'image' = 画图专用模型：不进聊天候选、不能被设为当前聊天模型 */
  kind?: 'image' | '';
  baseUrl: string;
  model: string;
  /** 云端模型才用；只存本机 */
  apiKey?: string;
  note?: string;
}

export type CollectionName = keyof AllData;

export type PageKey =
  | 'home'
  | 'today'
  | 'assistant'
  | 'study'
  | 'media'
  | 'dev'
  | 'consulting'
  | 'fitness'
  | 'diet'
  | 'games'
  | 'design'
  | 'settings';
