/**
 * 纯文字聊天 → Vercel POST { message } / { reply }
 * 可选：<meta name="simple-chat-api" content="https://.../api/chat"> 覆盖默认 URL；
 * 若整站与 API 同域部署，可填相对路径 /api/chat 以避免 CORS。
 */
function getSimpleChatApiUrl() {
    const m = document.querySelector('meta[name="simple-chat-api"]');
    const raw = m && m.getAttribute('content') != null ? String(m.getAttribute('content')).trim() : '';
    if (raw) {
        if (raw.startsWith('/')) return raw;
        return raw.replace(/\/+$/, '') + (raw.includes('/api/') ? '' : '/api/chat');
    }
    return 'https://my-avatar-apikey.vercel.app/api/chat';
}

(function () {
    function escapeHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function getI18n() {
        const root = document.getElementById('simple-chat');
        return {
            loading: root?.dataset.loadingText || '…',
            errorGeneric: root?.dataset.errorGeneric || 'Request failed.',
            empty: root?.dataset.emptyHint || ''
        };
    }

    function init() {
        const root = document.getElementById('simple-chat');
        const messagesEl = document.getElementById('simple-chat-messages');
        const input = document.getElementById('simple-chat-input');
        const sendBtn = document.getElementById('simple-chat-send');
        const errorBanner = document.getElementById('simple-chat-error-banner');

        if (!root || !messagesEl || !input || !sendBtn) return;

        function hideError() {
            if (errorBanner) {
                errorBanner.textContent = '';
                errorBanner.classList.remove('is-visible');
            }
        }

        function showError(msg) {
            if (errorBanner) {
                errorBanner.textContent = msg;
                errorBanner.classList.add('is-visible');
            }
        }

        function appendMessage(role, text) {
            const div = document.createElement('div');
            div.className =
                'simple-chat-msg simple-chat-msg--' +
                (role === 'user' ? 'user' : 'assistant');
            div.textContent = text;
            messagesEl.appendChild(div);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        function setLoading(on, loadingEl) {
            sendBtn.disabled = on;
            input.disabled = on;
            if (on && loadingEl) {
                messagesEl.appendChild(loadingEl);
                messagesEl.scrollTop = messagesEl.scrollHeight;
            } else if (!on && loadingEl && loadingEl.parentNode) {
                loadingEl.remove();
            }
        }

        async function send() {
            const text = input.value.trim();
            const i18n = getI18n();
            hideError();

            if (!text) {
                if (i18n.empty) showError(i18n.empty);
                return;
            }

            appendMessage('user', text);
            input.value = '';

            const loadingEl = document.createElement('div');
            loadingEl.className = 'simple-chat-msg simple-chat-msg--loading';
            loadingEl.setAttribute('role', 'status');
            loadingEl.innerHTML =
                '<span class="simple-chat-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span> ' +
                escapeHtml(i18n.loading);

            setLoading(true, loadingEl);

            try {
                const url = getSimpleChatApiUrl();
                const res = await fetch(url, {
                    method: 'POST',
                    mode: 'cors',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: text })
                });

                let data = null;
                const raw = await res.text();
                try {
                    data = raw ? JSON.parse(raw) : null;
                } catch {
                    data = null;
                }

                setLoading(false, loadingEl);

                if (!res.ok) {
                    const errMsg =
                        (data && (data.error || data.message)) ||
                        i18n.errorGeneric + ' (' + res.status + ')';
                    showError(String(errMsg));
                    const errLine = document.createElement('div');
                    errLine.className = 'simple-chat-msg simple-chat-msg--error';
                    errLine.textContent = String(errMsg);
                    messagesEl.appendChild(errLine);
                    messagesEl.scrollTop = messagesEl.scrollHeight;
                    return;
                }

                const reply = data && data.reply != null ? String(data.reply) : '';
                if (reply) {
                    appendMessage('assistant', reply);
                } else {
                    showError(i18n.errorGeneric);
                }
            } catch (e) {
                setLoading(false, loadingEl);
                const detail = e && e.message ? String(e.message) : '';
                const msg =
                    detail && (detail.includes('Failed to fetch') || detail.includes('NetworkError'))
                        ? i18n.errorGeneric +
                          ' （多为跨域：请把带 OPTIONS/CORS 的 api/chat 重新部署到 Vercel，或把页面与 API 部署在同域并用 /api/chat）'
                        : i18n.errorGeneric + (detail ? ' ' + detail : '');
                showError(msg);
                const errLine = document.createElement('div');
                errLine.className = 'simple-chat-msg simple-chat-msg--error';
                errLine.textContent = msg;
                messagesEl.appendChild(errLine);
                messagesEl.scrollTop = messagesEl.scrollHeight;
            }
        }

        sendBtn.addEventListener('click', send);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
