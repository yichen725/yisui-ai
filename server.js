/**
 * 逸碎 AI 后端代理服务
 * 作用：把 API Key 藏在服务端环境变量中，前端只请求本服务，由本服务转发到 OpenAI/DeepSeek 等接口
 * 支持流式响应（SSE）转发
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 服务前端静态文件（public/index.html）
app.use(express.static(path.join(__dirname, 'public')));

/**
 * 聊天代理接口
 * 请求体：{ apiUrl, model, messages, temperature, maxTokens, stream }
 * API Key 从环境变量读取（OPENAI_KEY / DEEPSEEK_KEY / API_KEY）
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { apiUrl, model, messages, temperature, maxTokens, stream } = req.body;

    // 从环境变量读取 API Key（Render 后台配置，不暴露给前端）
    const apiKey = process.env.OPENAI_KEY || process.env.DEEPSEEK_KEY || process.env.API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: { message: '服务器未配置 API Key，请在 Render 服务的 Environment 中添加 OPENAI_KEY 变量' }
      });
    }

    if (!apiUrl || !model || !Array.isArray(messages)) {
      return res.status(400).json({
        error: { message: '缺少必要参数：apiUrl、model、messages' }
      });
    }

    // 转发到目标 API
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: typeof temperature === 'number' ? temperature : 0.7,
        max_tokens: typeof maxTokens === 'number' ? maxTokens : 4096,
        stream: stream !== false
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).send(errText);
    }

    if (stream !== false) {
      // 流式转发：保持 SSE 连接，逐块转发
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

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
    console.error('代理请求出错:', error);
    res.status(500).json({
      error: { message: '代理服务器错误：' + error.message }
    });
  }
});

// 健康检查接口
app.get('/api/health', (req, res) => {
  const hasKey = !!(process.env.OPENAI_KEY || process.env.DEEPSEEK_KEY || process.env.API_KEY);
  res.json({ status: 'ok', apiKeyConfigured: hasKey });
});

app.listen(PORT, () => {
  console.log(`逸碎 AI 后端服务已启动，监听端口：${PORT}`);
});
