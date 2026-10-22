import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8790',
  },
  webServer: {
    command: 'npm run e2e:serve',
    url: 'http://127.0.0.1:8790/api/health',
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PORT: '8790',
      DATA_DIR: '.e2e-data',
      NO_OPEN: '1',
      // 测试用假 whisper 引擎（真组件不能进测试，跑真实转写太慢）
      WHISPER_BIN: path.resolve(here, 'test-fixtures/fake-whisper.mjs'),
      WHISPER_MODEL: path.resolve(here, 'package.json'),
      // 测试用假 OCR（屏幕获取：忽略图片，返回固定文字）
      SCREEN_OCR_CMD: path.resolve(here, 'test-fixtures/fake-ocr.mjs'),
      // 视觉识别在 e2e 里走"像素印象"兜底：钉到死端口，避免真机 8083/11434 上的
      // 模型慢响应干扰（发图流程会先等视觉描述，真模型 CPU 上要十几秒）
      VISION_URL: 'http://127.0.0.1:59998/v1',
      OLLAMA_URL: 'http://127.0.0.1:59999/v1',
      // 模型管家在 e2e 里禁用自动启停：绝不碰真机上的模型进程
      NO_AUTOSTART: '1',
      // 记忆树在 e2e 里写到测试目录，绝不碰真机 D:\AI助手记忆
      MEMORY_DIR: path.resolve(here, '.e2e-data', 'memory-files'),
    },
  },
});
