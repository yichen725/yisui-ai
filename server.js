/**
 * 逸碎 AI 后端服务
 * 功能：
 *   1. POST /v1/chat/completions - 转发聊天请求到 OpenAI/DeepSeek API（隐藏 API Key，支持流式）
 *   2. POST /verify - 卡密验证接口
 *   3. GET /health - 健康检查
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CARDS_FILE = path.join(__dirname, 'cards.json');

// 中间件
app.use(cors()); // 允许所有来源
app.use(express.json({ limit: '10mb' }));

// ============ 工具函数 ============

/**
 * 读取卡密文件
 */
function readCards() {
  try {
    if (!fs.existsSync(CARDS_FILE)) {
      return [];
    }
    const data = fs.readFileSync(CARDS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    console.error('读取卡密文件失败:', e.message);
    return [];
  }
}

/**
 * 写入卡密文件
 */
function writeCards(cards) {
  try {
    fs.writeFileSync(CARDS_FILE, JSON.stringify(cards, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('写入卡密文件失败:', e.message);
    return false;
  }
}

// ============ 接口 1：卡密验证 ============

/**
 * POST /verify
 * 请求体：{ "key": "卡密字符串" }
 * 响应：
 *   成功：{ "success": true, "message": "验证成功" }
 *   失败：{ "success": false, "message": "卡密无效或已使用" }
 */
app.post('/verify', (req, res) => {
  try {
    const { key } = req.body;

    if (!key || typeof key !== 'string') {
      return res.status(400).json({
        success: false,
        message: '请提供卡密'
      });
    }

    const cards = readCards();
    const card = cards.find(c => c.key === key.trim());

    if (!card) {
      return res.json({
        success: false,
        message: '卡密无效，请检查后重试'
      });
    }

    if (card.used) {
      return res.json({
        success: false,
        message: '该卡密已被使用'
      });
    }

    // 标记为已使用
    card.used = true;
    card.usedAt = new Date().toISOString();
    writeCards(cards);

    return res.json({
      success: true,
      message: '验证成功，欢迎使用逸碎 AI！'
    });

  } catch (error) {
    console.error('卡密验证出错:', error);
    return res.status(500).json({
      success: false,
      message: '服务器错误：' + error.message
    });
  }
});

// ============ 接口 2：聊天代理（转发到 OpenAI/DeepSeek） ============

/**
 * POST /v1/chat/completions
 * 请求体（兼容 OpenAI 格式）：
 *   {
 *     "model": "deepseek-chat",
 *     "messages": [{ "role": "user", "content": "你好" }],
 *     "temperature": 0.7,
 *     "max_tokens": 4096,
 *     "stream": true,
 *     "apiUrl": "https://api.deepseek.com/v1/chat/completions"  // 可选，覆盖默认目标地址
 *   }
 *
 * 环境变量：
 *   OPENAI_KEY  - API Key（必填）
 *   TARGET_API_URL - 默认转发目标地址（可选，默认 https://api.deepseek.com/v1/chat/completions）
 */
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const {
      model,
      messages,
      temperature,
      max_tokens,
      stream,
      apiUrl
    } = req.body;

    // 从环境变量读取 API Key
    const apiKey = process.env.OPENAI_KEY || process.env.API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: {
          message: '服务器未配置 API Key，请在平台环境变量中添加 OPENAI_KEY'
        }
      });
    }

    if (!model || !Array.isArray(messages)) {
      return res.status(400).json({
        error: { message: '缺少必要参数：model 和 messages' }
      });
    }

    // 确定目标 API 地址
    const targetUrl = apiUrl || process.env.TARGET_API_URL || 'https://api.deepseek.com/v1/chat/completions';

    // 构建转发请求体
    const requestBody = {
      model,
      messages,
      temperature: typeof temperature === 'number' ? temperature : 0.7,
      max_tokens: typeof max_tokens === 'number' ? max_tokens : 4096,
      stream: stream !== false
    };

    // 发起转发请求
    const response = await fetch(targetUrl, {
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
      // 非流式：直接返回 JSON
      const data = await response.json();
      res.json(data);
    }

  } catch (error) {
    console.error('聊天代理出错:', error);
    return res.status(500).json({
      error: { message: '代理服务器错误：' + error.message }
    });
  }
});

// ============ 接口 3：健康检查 ============

app.get('/health', (req, res) => {
  const hasKey = !!(process.env.OPENAI_KEY || process.env.API_KEY);
  const cards = readCards();
  const totalCards = cards.length;
  const usedCards = cards.filter(c => c.used).length;

  res.json({
    status: 'ok',
    apiKeyConfigured: hasKey,
    totalCards,
    usedCards,
    availableCards: totalCards - usedCards
  });
});

// ============ 启动服务 ============

app.listen(PORT, () => {
  console.log('========================================');
  console.log('  逸碎 AI 后端服务已启动');
  console.log('  端口:', PORT);
  console.log('  聊天接口: POST /v1/chat/completions');
  console.log('  卡密验证: POST /verify');
  console.log('  健康检查: GET /health');
  console.log('  API Key 已配置:', !!(process.env.OPENAI_KEY || process.env.API_KEY));
  console.log('========================================');
});
