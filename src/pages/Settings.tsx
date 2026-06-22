import { useState, useEffect } from 'react';
import { Save, Settings2, Key, Link2, Brain } from 'lucide-react';

export default function Settings() {
  const [config, setConfig] = useState({
    ai_base_url: '',
    ai_api_key: '',
    ai_model: '',
    ai_sentiment_prompt: '',
    ai_picks_prompt: '',
    ai_review_prompt: '',
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setConfig({
            ai_base_url: d.data.ai_base_url || '',
            ai_api_key: d.data.ai_api_key || '',
            ai_model: d.data.ai_model || '',
            ai_sentiment_prompt: d.data.ai_sentiment_prompt || '',
            ai_picks_prompt: d.data.ai_picks_prompt || '',
            ai_review_prompt: d.data.ai_review_prompt || '',
          });
        }
      });
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (data.success) {
        setSaveMessage('保存成功！');
        setTimeout(() => setSaveMessage(''), 3000);
      }
    } catch (e) {
      console.error(e);
      setSaveMessage('保存设置失败。');
    }
    setIsSaving(false);
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto p-6">
      <div className="flex items-center space-x-3 mb-8">
        <Settings2 className="w-8 h-8 text-primary" />
        <h1 className="text-3xl font-bold text-white">全局设置</h1>
      </div>

      {/* B4 修复：替换所有未定义令牌为项目令牌 */}
      <div className="bg-surface-card-dark rounded-xl p-6 border border-hairline-dark shadow-xl">
        <div className="flex items-center space-x-2 mb-6 border-b border-hairline-dark pb-4">
          <Brain className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-semibold text-white">大模型服务商配置</h2>
        </div>

        <p className="text-sm text-muted mb-6">
          配置兼容 OpenAI 格式的大模型服务商（如 OpenAI、DeepSeek、Kimi，或经过代理的 Anthropic）。
          这些设置将全局应用于 AI 情绪分析和 AI 智能选股功能。
        </p>

        <div className="space-y-6">
          <div>
            <label className="flex items-center text-sm font-medium text-body-dark mb-2">
              <Link2 className="w-4 h-4 mr-2" />
              API 请求地址 (Base URL)
            </label>
            <input
              type="text"
              value={config.ai_base_url}
              onChange={(e) => setConfig({ ...config, ai_base_url: e.target.value })}
              placeholder="e.g. https://api.deepseek.com/v1"
              className="w-full bg-canvas-dark border border-hairline-dark rounded-lg px-4 py-2 text-white placeholder:text-muted focus:outline-none focus:border-primary transition-colors"
            />
          </div>

          <div>
            <label className="flex items-center text-sm font-medium text-body-dark mb-2">
              <Key className="w-4 h-4 mr-2" />
              API 密钥 (API Key)
            </label>
            <input
              type="password"
              value={config.ai_api_key}
              onChange={(e) => setConfig({ ...config, ai_api_key: e.target.value })}
              placeholder="sk-...（脱敏值含 **** 表示已有配置，重新输入覆盖）"
              className="w-full bg-canvas-dark border border-hairline-dark rounded-lg px-4 py-2 text-white placeholder:text-muted focus:outline-none focus:border-primary transition-colors"
            />
          </div>

          <div>
            <label className="flex items-center text-sm font-medium text-body-dark mb-2">
              <Brain className="w-4 h-4 mr-2" />
              模型名称 (Model Name)
            </label>
            <input
              type="text"
              value={config.ai_model}
              onChange={(e) => setConfig({ ...config, ai_model: e.target.value })}
              placeholder="e.g. deepseek-chat or gpt-4o"
              className="w-full bg-canvas-dark border border-hairline-dark rounded-lg px-4 py-2 text-white placeholder:text-muted focus:outline-none focus:border-primary transition-colors"
            />
          </div>

          <div>
            <label className="flex items-center text-sm font-medium text-body-dark mb-2">
              情绪分析提示词 (可选)
            </label>
            <textarea
              value={config.ai_sentiment_prompt}
              onChange={(e) => setConfig({ ...config, ai_sentiment_prompt: e.target.value })}
              placeholder="留空则使用默认系统提示词..."
              rows={4}
              className="w-full bg-canvas-dark border border-hairline-dark rounded-lg px-4 py-2 text-white placeholder:text-muted focus:outline-none focus:border-primary transition-colors resize-none"
            />
            <p className="text-xs text-muted mt-2">
              覆盖默认提示词。如果选择覆盖，请务必确保您的提示词要求模型返回符合系统要求的 JSON 格式数据。
            </p>
          </div>

          <div>
            <label className="flex items-center text-sm font-medium text-body-dark mb-2">
              智能选股提示词 (可选)
            </label>
            <textarea
              value={config.ai_picks_prompt}
              onChange={(e) => setConfig({ ...config, ai_picks_prompt: e.target.value })}
              placeholder="留空则使用默认系统提示词。可使用 {{strategy}} 和 {{count}} 变量..."
              rows={6}
              className="w-full bg-canvas-dark border border-hairline-dark rounded-lg px-4 py-2 text-white placeholder:text-muted focus:outline-none focus:border-primary transition-colors resize-none"
            />
            <p className="text-xs text-muted mt-2">
              覆盖默认多因子选股提示词。请务必确保返回系统约定的 JSON 结构 (包含 picks 数组)。可以使用 {'{{strategy}}'} 和 {'{{count}}'} 占位符。
            </p>
          </div>

          <div>
            <label className="flex items-center text-sm font-medium text-body-dark mb-2">
              复盘教练提示词 (可选)
            </label>
            <textarea
              value={config.ai_review_prompt}
              onChange={(e) => setConfig({ ...config, ai_review_prompt: e.target.value })}
              placeholder="留空则使用默认系统提示词..."
              rows={6}
              className="w-full bg-canvas-dark border border-hairline-dark rounded-lg px-4 py-2 text-white placeholder:text-muted focus:outline-none focus:border-primary transition-colors resize-none"
            />
            <p className="text-xs text-muted mt-2">
              复盘教练 AI 角色：分析历史推荐的盈亏，提炼可执行的策略优化建议，驱动 AutoResearch 闭环。
            </p>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-hairline-dark flex items-center justify-between">
          <span className={`text-sm ${saveMessage.includes('失败') ? 'text-trading-down' : 'text-trading-up'}`}>{saveMessage}</span>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center space-x-2 bg-primary text-ink px-6 py-2.5 rounded-lg font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            <span>{isSaving ? '保存中...' : '保存设置'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
