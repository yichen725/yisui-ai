/**
 * 逸碎 AI 后端服务
 * 功能：
 *   1. POST /v1/chat/completions - 统一聊天代理，根据 model 自动路由到对应 API（隐藏所有 API Key，支持流式）
 *   2. GET /models - 获取可用模型列表（仅返回已配置 API Key 的模型）
 *   3. POST /verify - 卡密验证接口
 *   4. GET /health - 健康检查
 */
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

const CARDS_FILE = path.join(__dirname, 'cards.json');
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-v4-pro';

// 中间件
app.use(cors()); // 允许所有来源
app.use(express.json({ limit: '10mb' }));

// ============ 模型配置（后端统一管理，前端不可见） ============
/**
 * 每个模型对应：
 *   apiUrl    - 目标 API 地址
 *   apiKeyEnv - 读取哪个环境变量作为 API Key
 *   name      - 前端显示名称
 *   provider  - 服务商标识
 */
const MODEL_CONFIG = {
  // DeepSeek 系列
  // DeepSeek V4 系列
  'deepseek-v4-flash': {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKeyEnv: 'DEEPSEEK_KEY',
    name: 'DeepSeek V4 Flash（极速）',
    provider: 'deepseek'
  },
  'deepseek-v4-pro': {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKeyEnv: 'DEEPSEEK_KEY',
    name: 'DeepSeek V4 Pro（旗舰）',
    provider: 'deepseek'
  },
  'deepseek-v4-flash-vision-exp': {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKeyEnv: 'DEEPSEEK_KEY',
    name: 'DeepSeek V4 Flash Vision（视觉识别）',
    provider: 'deepseek'
  },
  // DeepSeek V3 / R1 系列
  'deepseek-chat': {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKeyEnv: 'DEEPSEEK_KEY',
    name: 'DeepSeek V3（通用）',
    provider: 'deepseek'
  },
  'deepseek-reasoner': {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKeyEnv: 'DEEPSEEK_KEY',
    name: 'DeepSeek R1（推理）',
    provider: 'deepseek'
  },
  // OpenAI 系列
  'gpt-4o': {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKeyEnv: 'OPENAI_KEY',
    name: 'GPT-4o',
    provider: 'openai'
  },
  'gpt-4o-mini': {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKeyEnv: 'OPENAI_KEY',
    name: 'GPT-4o Mini',
    provider: 'openai'
  },
  'gpt-3.5-turbo': {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKeyEnv: 'OPENAI_KEY',
    name: 'GPT-3.5 Turbo',
    provider: 'openai'
  },
  // 通义千问（DashScope 兼容 OpenAI 格式）
  'qwen-plus': {
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    apiKeyEnv: 'QWEN_KEY',
    name: '通义千问 Qwen-Plus',
    provider: 'qwen'
  },
  'qwen-turbo': {
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    apiKeyEnv: 'QWEN_KEY',
    name: '通义千问 Qwen-Turbo',
    provider: 'qwen'
  }
};

/**
 * 获取指定模型的 API Key（带兼容回退）
 * 兼容逻辑：如果 DEEPSEEK_KEY 未配置，回退到 OPENAI_KEY（因为用户可能把 DeepSeek Key 存在 OPENAI_KEY 里）
 */
// 检测消息中是否包含图片
function hasImageInMessages(messages) {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === 'image_url' || item.type === 'image') {
          return true;
        }
      }
    }
  }
  return false;
}

function getModelApiKey(modelConfig) {
  const key = process.env[modelConfig.apiKeyEnv];
  if (key) return key;
  // 兼容回退：DeepSeek 未配置时，尝试用 OPENAI_KEY
  if (modelConfig.provider === 'deepseek' && process.env.OPENAI_KEY) {
    return process.env.OPENAI_KEY;
  }
  return null;
}

/**
 * 获取已配置 API Key 的可用模型列表
 */
function getAvailableModels() {
  const available = [];
  for (const [modelId, config] of Object.entries(MODEL_CONFIG)) {
    const apiKey = getModelApiKey(config);
    if (apiKey) {
      available.push({
        id: modelId,
        name: config.name,
        provider: config.provider
      });
    }
  }
  return available;
}

// ============ 工具函数 ============
function readCards() {
  try {
    if (!fs.existsSync(CARDS_FILE)) return [];
    const data = fs.readFileSync(CARDS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    console.error('读取卡密文件失败:', e.message);
    return [];
  }
}

function writeCards(cards) {
  try {
    fs.writeFileSync(CARDS_FILE, JSON.stringify(cards, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('写入卡密文件失败:', e.message);
    return false;
  }
}

// ============ 接口 1：获取可用模型列表 ============
/**
 * GET /models
 * 返回已配置 API Key 的模型列表，前端据此渲染模型选择器
 */
app.get('/models', (req, res) => {
  const models = getAvailableModels();
  res.json({ models });
});

// ============ 接口 2：卡密验证 ============
app.post('/verify', (req, res) => {
  try {
    const { key } = req.body;
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ success: false, message: '请提供卡密' });
    }
    const cards = readCards();
    const card = cards.find(c => c.key === key.trim());
    if (!card) {
      return res.json({ success: false, message: '卡密无效，请检查后重试' });
    }
    if (card.used) {
      return res.json({ success: false, message: '该卡密已被使用' });
    }
    card.used = true;
    card.usedAt = new Date().toISOString();
    writeCards(cards);
    return res.json({ success: true, message: '验证成功，欢迎使用逸碎 AI！' });
  } catch (error) {
    console.error('卡密验证出错:', error);
    return res.status(500).json({ success: false, message: '服务器错误：' + error.message });
  }
});

// ============ 接口 3：统一聊天代理（根据 model 自动路由） ============
/**
 * POST /v1/chat/completions
 * 请求体（兼容 OpenAI 格式）：
 *   {
 *     "model": "deepseek-chat",       // 模型 ID，必须是 /models 返回的可用模型
 *     "messages": [{ "role": "user", "content": "你好" }],
 *     "temperature": 0.7,
 *     "max_tokens": 4096,
 *     "stream": true
 *   }
 *
 * 注意：前端不再传 apiUrl、apiKey，全部由后端根据 model 自动匹配
 */
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, temperature, max_tokens, stream } = req.body;
    // 自动模型路由：有图片用 Vision 版，无图用 Pro 版
    let model = req.body.model || DEFAULT_MODEL;
    if (hasImageInMessages(messages)) {
      model = 'deepseek-v4-flash-vision-exp';
      console.log('检测到图片，自动切换到 Vision 模型');
    } else if (!MODEL_CONFIG[model]) {
      model = DEFAULT_MODEL;
    }

    if (!model || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: '缺少必要参数：model 和 messages' } });
    }

    // 根据 model 查找配置
    const modelConfig = MODEL_CONFIG[model];
    if (!modelConfig) {
      return res.status(400).json({
        error: { message: `不支持的模型：${model}，请调用 /models 获取可用列表` }
      });
    }

    // 从环境变量读取对应 API Key
    const apiKey = getModelApiKey(modelConfig);
    if (!apiKey) {
      return res.status(500).json({
        error: { message: `模型 ${model} 未配置 API Key，请在后端环境变量中添加 ${modelConfig.apiKeyEnv}` }
      });
    }

    // 构建转发请求体（移除前端可能传入的 apiUrl 等敏感覆盖字段）
    const requestBody = {
      model,
      messages,
      temperature: typeof temperature === 'number' ? temperature : 0.7,
      max_tokens: typeof max_tokens === 'number' ? max_tokens : 4096,
      stream: stream !== false
    };

    // 发起转发请求
    const response = await fetch(modelConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).send(errText);
    }

    // 流式响应转发
    if (stream !== false) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } else {
      const data = await response.json();
      res.json(data);
    }
  } catch (error) {
    console.error('聊天代理出错:', error);
    return res.status(500).json({ error: { message: '代理服务器错误：' + error.message } });
  }
});

// ============ 接口 4：健康检查 ============
app.get('/health', (req, res) => {
  const availableModels = getAvailableModels();
  const cards = readCards();
  const totalCards = cards.length;
  const usedCards = cards.filter(c => c.used).length;

  // 统计各服务商 Key 配置状态
  const providers = {};
  for (const config of Object.values(MODEL_CONFIG)) {
    if (!providers[config.provider]) {
      providers[config.provider] = {
        configured: !!getModelApiKey(config),
        envVar: config.apiKeyEnv
      };
    }
  }

  res.json({
    status: 'ok',
    availableModels: availableModels.length,
    models: availableModels,
    providers,
    totalCards,
    usedCards,
    availableCards: totalCards - usedCards
  });
});

// ============ 启动服务 ============
app.listen(PORT, () => {
  const availableModels = getAvailableModels();
  console.log('========================================');
  console.log('  逸碎 AI 后端服务已启动（模型后端统一管理）');
  console.log('  端口:', PORT);
  console.log('  聊天接口: POST /v1/chat/completions');
  console.log('  模型列表: GET /models');
  console.log('  卡密验证: POST /verify');
  console.log('  健康检查: GET /health');
  console.log('  可用模型数量:', availableModels.length);
  availableModels.forEach(m => {
    console.log('    -', m.id, '(' + m.name + ')');
  });
  console.log('========================================');
});
