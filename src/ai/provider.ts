/**
 * AI Provider abstraction for ClawdContext.
 *
 * Supports OpenAI, Anthropic (Claude), and Ollama — all optional.
 * Uses Node.js built-in https/http modules (no SDK dependencies).
 * Supports enterprise CA certificates and proxy configurations.
 */

import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as tls from 'tls';

// ─── Types ──────────────────────────────────────────────────────────

export type AiProvider = 'none' | 'openai' | 'anthropic' | 'ollama';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompletionOptions {
  messages: AiMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface AiCompletionResult {
  content: string;
  model: string;
  tokensUsed?: number;
}

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  caCertPath: string;
  rejectUnauthorized: boolean;
  timeout: number;
}

// ─── Configuration ──────────────────────────────────────────────────

const DEFAULT_MODELS: Record<Exclude<AiProvider, 'none'>, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-20250514',
  ollama: 'llama3.2',
};

const DEFAULT_URLS: Record<Exclude<AiProvider, 'none'>, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://localhost:11434',
};

export function getAiConfig(): AiConfig {
  const cfg = vscode.workspace.getConfiguration('clawdcontext.ai');
  const provider = cfg.get<AiProvider>('provider', 'none');

  return {
    provider,
    apiKey: cfg.get<string>('apiKey', ''),
    model: cfg.get<string>('model', '') || (provider !== 'none' ? DEFAULT_MODELS[provider] : ''),
    baseUrl: cfg.get<string>('baseUrl', '') || (provider !== 'none' ? DEFAULT_URLS[provider] : ''),
    caCertPath: cfg.get<string>('caCertPath', ''),
    rejectUnauthorized: cfg.get<boolean>('rejectUnauthorized', true),
    timeout: cfg.get<number>('timeout', 30000),
  };
}

export function isAiEnabled(): boolean {
  const config = getAiConfig();
  if (config.provider === 'none') { return false; }
  // Ollama doesn't need an API key
  if (config.provider === 'ollama') { return true; }
  return config.apiKey.length > 0;
}

// ─── TLS / Certificate Handling ─────────────────────────────────────

/**
 * Build HTTPS agent with enterprise certificate support.
 * Supports:
 * - Custom CA certificate bundles (PEM files)
 * - Concatenated CA chains
 * - Disabling TLS verification (not recommended, but needed for some proxies)
 */
function buildHttpsAgent(config: AiConfig): https.Agent {
  const options: https.AgentOptions = {
    rejectUnauthorized: config.rejectUnauthorized,
    keepAlive: true,
  };

  if (config.caCertPath) {
    try {
      const certPath = config.caCertPath.replace(/^~/, process.env.HOME || '');
      if (fs.existsSync(certPath)) {
        const caCert = fs.readFileSync(certPath);
        // Combine with system CAs so both enterprise and public CAs work
        options.ca = [
          ...tls.rootCertificates,
          caCert.toString(),
        ];
        console.log(`ClawdContext AI: loaded CA certificate from ${certPath}`);
      } else {
        console.warn(`ClawdContext AI: CA cert not found at ${certPath}`);
      }
    } catch (err) {
      console.error(`ClawdContext AI: failed to load CA cert: ${err}`);
    }
  }

  return new https.Agent(options);
}

// ─── HTTP Request Helper ────────────────────────────────────────────

interface RequestOptions {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: string;
  config: AiConfig;
}

function makeRequest(opts: RequestOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(opts.url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const reqOptions: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ClawdContext-VSCode/0.4.0',
        ...opts.headers,
      },
      timeout: opts.config.timeout,
    };

    if (isHttps) {
      reqOptions.agent = buildHttpsAgent(opts.config);
    }

    const req = transport.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(
            `AI API error ${res.statusCode}: ${data.substring(0, 500)}`
          ));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`AI API request timed out after ${opts.config.timeout}ms`));
    });

    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

// ─── Provider Implementations ───────────────────────────────────────

async function completeOpenAI(config: AiConfig, options: AiCompletionOptions): Promise<AiCompletionResult> {
  const body = JSON.stringify({
    model: config.model,
    messages: options.messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 2000,
  });

  const response = await makeRequest({
    url: `${config.baseUrl}/v1/chat/completions`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body,
    config,
  });

  const json = JSON.parse(response);
  return {
    content: json.choices?.[0]?.message?.content || '',
    model: json.model || config.model,
    tokensUsed: json.usage?.total_tokens,
  };
}

async function completeAnthropic(config: AiConfig, options: AiCompletionOptions): Promise<AiCompletionResult> {
  // Anthropic uses a different format: system is separate, messages are user/assistant only
  const systemMsg = options.messages.find(m => m.role === 'system');
  const chatMessages = options.messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));

  const body = JSON.stringify({
    model: config.model,
    max_tokens: options.maxTokens ?? 2000,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages: chatMessages,
    temperature: options.temperature ?? 0.3,
  });

  const response = await makeRequest({
    url: `${config.baseUrl}/v1/messages`,
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body,
    config,
  });

  const json = JSON.parse(response);
  const textBlock = json.content?.find((b: { type: string }) => b.type === 'text');
  return {
    content: textBlock?.text || '',
    model: json.model || config.model,
    tokensUsed: json.usage ? (json.usage.input_tokens + json.usage.output_tokens) : undefined,
  };
}

async function completeOllama(config: AiConfig, options: AiCompletionOptions): Promise<AiCompletionResult> {
  const body = JSON.stringify({
    model: config.model,
    messages: options.messages,
    stream: false,
    options: {
      temperature: options.temperature ?? 0.3,
      num_predict: options.maxTokens ?? 2000,
    },
  });

  const response = await makeRequest({
    url: `${config.baseUrl}/api/chat`,
    method: 'POST',
    headers: {},
    body,
    config,
  });

  const json = JSON.parse(response);
  return {
    content: json.message?.content || '',
    model: json.model || config.model,
    tokensUsed: json.eval_count ? (json.prompt_eval_count + json.eval_count) : undefined,
  };
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Send a completion request to the configured AI provider.
 * Throws if AI is not configured or the request fails.
 */
export async function aiComplete(options: AiCompletionOptions): Promise<AiCompletionResult> {
  const config = getAiConfig();

  if (config.provider === 'none') {
    throw new Error('AI is not configured. Set clawdcontext.ai.provider in settings.');
  }

  if (config.provider !== 'ollama' && !config.apiKey) {
    throw new Error(`API key required for ${config.provider}. Set clawdcontext.ai.apiKey in settings.`);
  }

  switch (config.provider) {
    case 'openai':    return completeOpenAI(config, options);
    case 'anthropic': return completeAnthropic(config, options);
    case 'ollama':    return completeOllama(config, options);
    default:
      throw new Error(`Unknown AI provider: ${config.provider}`);
  }
}

/**
 * Test the AI connection with a simple ping.
 * Returns the model name on success, throws on failure.
 */
export async function testAiConnection(): Promise<string> {
  const result = await aiComplete({
    messages: [
      { role: 'system', content: 'You are a test assistant. Reply with exactly: "ClawdContext AI connected"' },
      { role: 'user', content: 'ping' },
    ],
    maxTokens: 20,
    temperature: 0,
  });
  return `Connected to ${result.model}`;
}
