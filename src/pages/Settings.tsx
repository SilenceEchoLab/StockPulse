import { useState, useEffect } from 'react';
import { Save, Settings2, Key, Link2, Brain } from 'lucide-react';

export default function Settings() {
  const [config, setConfig] = useState({
    ai_base_url: '',
    ai_api_key: '',
    ai_model: '',
    ai_sentiment_prompt: '',
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
        setSaveMessage('Saved successfully!');
        setTimeout(() => setSaveMessage(''), 3000);
      }
    } catch (e) {
      console.error(e);
      setSaveMessage('Failed to save settings.');
    }
    setIsSaving(false);
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto p-6">
      <div className="flex items-center space-x-3 mb-8">
        <Settings2 className="w-8 h-8 text-primary" />
        <h1 className="text-3xl font-bold">Global Settings</h1>
      </div>

      <div className="bg-panel rounded-xl p-6 border border-white/5 shadow-xl">
        <div className="flex items-center space-x-2 mb-6 border-b border-white/10 pb-4">
          <Brain className="w-5 h-5 text-primary" />
          <h2 className="text-xl font-semibold">AI Provider Configuration</h2>
        </div>

        <p className="text-sm text-gray-400 mb-6">
          Configure an OpenAI-compatible API provider (e.g. OpenAI, DeepSeek, Kimi, Anthropic via proxy). 
          These settings are used globally for AI Sentiment Analysis and AI Stock Picks.
        </p>

        <div className="space-y-6">
          <div>
            <label className="flex items-center text-sm font-medium text-gray-300 mb-2">
              <Link2 className="w-4 h-4 mr-2" />
              Base URL
            </label>
            <input
              type="text"
              value={config.ai_base_url}
              onChange={(e) => setConfig({ ...config, ai_base_url: e.target.value })}
              placeholder="e.g. https://api.deepseek.com/v1"
              className="w-full bg-dark/50 border border-white/10 rounded-lg px-4 py-2 text-white placeholder:text-gray-600 focus:outline-none focus:border-primary transition-colors"
            />
          </div>

          <div>
            <label className="flex items-center text-sm font-medium text-gray-300 mb-2">
              <Key className="w-4 h-4 mr-2" />
              API Key
            </label>
            <input
              type="password"
              value={config.ai_api_key}
              onChange={(e) => setConfig({ ...config, ai_api_key: e.target.value })}
              placeholder="sk-..."
              className="w-full bg-dark/50 border border-white/10 rounded-lg px-4 py-2 text-white placeholder:text-gray-600 focus:outline-none focus:border-primary transition-colors"
            />
          </div>

          <div>
            <label className="flex items-center text-sm font-medium text-gray-300 mb-2">
              <Brain className="w-4 h-4 mr-2" />
              Model Name
            </label>
            <input
              type="text"
              value={config.ai_model}
              onChange={(e) => setConfig({ ...config, ai_model: e.target.value })}
              placeholder="e.g. deepseek-chat or gpt-4o"
              className="w-full bg-dark/50 border border-white/10 rounded-lg px-4 py-2 text-white placeholder:text-gray-600 focus:outline-none focus:border-primary transition-colors"
            />
          </div>

          <div>
            <label className="flex items-center text-sm font-medium text-gray-300 mb-2">
              Sentiment Analysis Prompt (Optional)
            </label>
            <textarea
              value={config.ai_sentiment_prompt}
              onChange={(e) => setConfig({ ...config, ai_sentiment_prompt: e.target.value })}
              placeholder="Leave empty to use default system prompt..."
              rows={4}
              className="w-full bg-dark/50 border border-white/10 rounded-lg px-4 py-2 text-white placeholder:text-gray-600 focus:outline-none focus:border-primary transition-colors resize-none"
            />
            <p className="text-xs text-gray-500 mt-2">
              Override the default prompt. Ensure your prompt requests JSON matching the application's required schema if you override this.
            </p>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-white/10 flex items-center justify-between">
          <span className="text-sm text-green-400">{saveMessage}</span>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center space-x-2 bg-primary text-black px-6 py-2.5 rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            <span>{isSaving ? 'Saving...' : 'Save Settings'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
