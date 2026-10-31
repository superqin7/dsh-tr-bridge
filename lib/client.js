window.__ModuleLoader__.load({
  id: 'dsh-tr-bridge',
  factory(require) {
    let React = null
    let Button = null
    try { React = require('react') } catch { React = null }
    try { Button = require('@deepseek-ai/dsh-client-ui-primitives').Button } catch { Button = null }
    const h = React ? React.createElement : null
    const NS = 'tr-bridge.config'
    const CHANNEL = '/dsh-tr-bridge'
    const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

    const zh = {
      summary: '配置 Codex 与 Grok 的默认模型',
      intro: '打开本页时会向宿主查询当前已登录的 tr。下拉项只来自这一次查询，不会写死模型 ID，也不需要填写 API Key。只有保存才会写入；离开页面会丢弃未保存的修改。',
      refresh: '刷新模型列表',
      refreshing: '正在刷新',
      save: '保存默认模型',
      saving: '正在保存',
      loading: '正在读取当前授权模型',
      connected: '已连接',
      'authorization-revoked': '授权已撤销或尚未登录',
      'launcher-missing': '找不到 tr',
      'query-failed': '模型获取失败',
      incomplete: '清单不完整，已拒绝使用',
      timeout: '查询超时',
      unknown: '尚未查询',
      'selection-unreadable': '已保存的选择无法读取',
      'channel-unavailable': '配置通道不可用。插件工具仍可使用。',
      'client-unavailable': '配置页组件没有加载。插件工具仍可使用。',
      stale: '当前选择已失效',
      'profile-stale': '插件配置中的模型已不在本次清单',
      'profile-override': '插件配置优先于这里保存的默认值',
      unverified: '当前选择尚未经过本次清单确认',
      unset: '未设置，调用时沿用 CLI 默认',
      ok: '当前选择仍在本次清单中',
      'group-model': '可调用模型',
      'group-alias': 'CLI 标明的路由别名',
      empty: '本次没有可选项',
      'alias-note': '路由别名不是模型身份。CLI 这样标明的条目仍可选择，但不能把它当成模型名称的证明。',
      'cli-default': '沿用 CLI 默认',
      'alias-suffix': '路由别名',
      'save-ok': '已保存',
      'save-failed': '保存失败',
      excluded: '另有未放入下拉框的条目',
      codex: 'Codex',
      grok: 'Grok',
      'render-failed': '配置页渲染失败。插件工具仍可使用。',
    }
    const en = {
      summary: 'Choose default Codex and Grok models',
      intro: 'Opening this page asks the host for the tr login already on this device. Options come only from that query. No model ID is hardcoded, and no API key is requested. Only Save writes; leaving discards unsaved edits.',
      refresh: 'Refresh models',
      refreshing: 'Refreshing',
      save: 'Save defaults',
      saving: 'Saving',
      loading: 'Loading authorized models',
      connected: 'Connected',
      'authorization-revoked': 'Authorization revoked or not signed in',
      'launcher-missing': 'tr was not found',
      'query-failed': 'Model query failed',
      incomplete: 'Catalog was incomplete and was rejected',
      timeout: 'Query timed out',
      unknown: 'Not queried yet',
      'selection-unreadable': 'Saved selection could not be read',
      'channel-unavailable': 'The config channel is unavailable. Plugin tools still work.',
      'client-unavailable': 'The config page components did not load. Plugin tools still work.',
      stale: 'The current selection is no longer valid',
      'profile-stale': 'The profile model is not in this catalog',
      'profile-override': 'The plugin profile overrides the default saved here',
      unverified: 'The current selection has not been confirmed against this catalog',
      unset: 'Unset. Calls keep the CLI default',
      ok: 'The current selection is in this catalog',
      'group-model': 'Callable models',
      'group-alias': 'Route aliases reported by the CLI',
      empty: 'This query returned no choices',
      'alias-note': 'A route alias is not a model identity. CLI-marked aliases stay selectable, but they do not prove a model name.',
      'cli-default': 'Use the CLI default',
      'alias-suffix': 'route alias',
      'save-ok': 'Saved',
      'save-failed': 'Save failed',
      excluded: 'Some entries were left out of the dropdown',
      codex: 'Codex',
      grok: 'Grok',
      'render-failed': 'The config page failed to render. Plugin tools still work.',
    }

    function safeId(value) {
      return typeof value === 'string' && MODEL_ID.test(value) ? value : ''
    }

    function displayError(error, t) {
      const code = error?.code
      if (code && zh[code]) return t(code)
      const message = typeof error?.message === 'string' ? error.message : ''
      if (!message || message.length > 240) return t('query-failed')
      if (/Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|password|TR_SETUP_KEY)\s*[:=]/i.test(message)) return t('query-failed')
      return message
    }

    function groupsFor(models) {
      const items = Array.isArray(models) ? models.filter(item => item && item.selectable && safeId(item.id)) : []
      return [
        { id: 'model', items: items.filter(item => item.kind !== 'alias' && item.kind !== 'routed') },
        { id: 'alias', items: items.filter(item => item.kind === 'alias' || item.kind === 'routed') },
      ].filter(group => group.items.length > 0)
    }

    function optionLabel(item, t) {
      const id = safeId(item.id)
      const name = typeof item.name === 'string' && item.name.trim() && item.name !== id ? item.name.trim() : id
      if (item.kind === 'alias' || item.kind === 'routed') {
        return name === id ? `${id}（${t('alias-suffix')}）` : `${name}（${id}，${t('alias-suffix')}）`
      }
      return name === id ? id : `${name}（${id}）`
    }

    function draftFor(agent) {
      if (!agent || agent.connection !== 'connected') return ''
      if (agent.selection !== 'ok' && agent.selection !== 'profile-override') return ''
      return safeId(agent.effective)
    }

    async function callHost(ctx, endpoint, payload) {
      const call = ctx?.connection?.rpc?.call
      if (typeof call !== 'function') {
        return { ok: false, error: { code: 'channel-unavailable', message: 'channel unavailable' } }
      }
      const result = await call(CHANNEL, endpoint, payload)
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        return { ok: false, error: { code: 'query-failed', message: 'query failed' } }
      }
      return result
    }

    function Control(props, children) {
      if (Button) return h(Button, props, children)
      return h('button', {
        type: 'button',
        disabled: props.disabled,
        onClick: props.onClick,
        style: buttonStyle(props.variant),
      }, children)
    }

    function buttonStyle(variant) {
      return {
        boxSizing: 'border-box',
        height: 36,
        border: 'none',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        padding: '0 14px',
        font: 'inherit',
        fontSize: 14,
        cursor: 'pointer',
        background: variant === 'primary'
          ? 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-accent, #247bbf))'
          : 'transparent',
        color: variant === 'primary'
          ? 'var(--dsw-alias-label-primary-foreground, #fff)'
          : 'var(--dsw-alias-label-primary, inherit)',
        outline: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.45))',
      }
    }

    const pageStyle = { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640, color: 'var(--dsw-alias-label-primary, inherit)' }
    const secondaryStyle = { margin: 0, color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 13, lineHeight: '20px' }
    const alertStyle = { margin: 0, color: 'var(--dsw-alias-status-error, #b42318)', fontSize: 13, lineHeight: '20px' }
    const okStyle = { margin: 0, color: 'var(--dsw-alias-status-success, #067647)', fontSize: 13, lineHeight: '20px' }
    const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
    const cardStyle = { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 'var(--dsw-radius-md, 8px)', background: 'var(--dsw-alias-bg-secondary, transparent)' }
    const selectStyle = {
      width: '100%',
      boxSizing: 'border-box',
      height: 36,
      borderRadius: 'var(--dsw-radius-md, 8px)',
      border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.45))',
      background: 'var(--dsw-alias-bg-primary, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      font: 'inherit',
      padding: '0 10px',
    }
    function statusStyle(connection) {
      const good = connection === 'connected'
      return { fontSize: 12, color: good ? 'var(--dsw-alias-status-success, #067647)' : 'var(--dsw-alias-status-error, #b42318)' }
    }

    function Page({ t, ctx }) {
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [agents, setAgents] = React.useState([])
      const [draft, setDraft] = React.useState({})
      const [touched, setTouched] = React.useState({})
      const [notice, setNotice] = React.useState('')
      const [error, setError] = React.useState('')
      const life = React.useState({ alive: true })[0]

      function applyAgents(next, replaceDraft) {
        const list = Array.isArray(next) ? next : []
        setAgents(list)
        if (!replaceDraft) return
        setDraft(current => {
          const merged = { ...current }
          for (const agent of list) {
            if (touched[agent.agent]) continue
            merged[agent.agent] = draftFor(agent)
          }
          return merged
        })
      }

      async function load(mode) {
        if (!life.alive) return
        setBusy(true)
        setError('')
        if (mode === 'refresh') setNotice('')
        try {
          if (mode !== 'refresh') {
            const status = await callHost(ctx, 'status', {})
            if (!life.alive) return
            if (status.ok) applyAgents(status.value?.agents, false)
            else setError(displayError(status.error, t))
          }
          const refreshed = await callHost(ctx, 'refresh', {})
          if (!life.alive) return
          if (!refreshed.ok) {
            setError(displayError(refreshed.error, t))
            setAgents(current => current.map(agent => ({ ...agent, models: [], connection: agent.connection === 'connected' ? 'query-failed' : agent.connection })))
            return
          }
          applyAgents(refreshed.value?.agents, true)
          setError('')
        } catch {
          if (life.alive) setError(t('query-failed'))
        } finally {
          if (!life.alive) return
          setBusy(false)
          setLoading(false)
        }
      }

      React.useEffect(() => {
        load('open')
        return () => { life.alive = false }
      }, [])

      async function save() {
        setSaving(true)
        setNotice('')
        setError('')
        try {
          for (const agent of agents) {
            if (agent.connection !== 'connected') continue
            const model = safeId(draft[agent.agent])
            const result = model
              ? await callHost(ctx, 'save', { agent: agent.agent, model })
              : await callHost(ctx, 'clear', { agent: agent.agent })
            if (!result.ok) {
              setError(displayError(result.error, t))
              return
            }
            if (Array.isArray(result.value?.agents)) applyAgents(result.value.agents, true)
          }
          setNotice(t('save-ok'))
          setTouched({})
        } catch {
          setError(t('save-failed'))
        } finally {
          setSaving(false)
        }
      }

      const ready = agents.some(agent => agent.connection === 'connected')
      return h('div', { style: pageStyle }, [
        h('p', { key: 'intro', style: secondaryStyle }, t('intro')),
        error ? h('p', { key: 'error', role: 'alert', style: alertStyle }, error) : null,
        notice ? h('p', { key: 'notice', style: okStyle }, notice) : null,
        h('div', { key: 'actions', style: rowStyle }, [
          Control({
            key: 'refresh',
            variant: 'outline',
            size: 'sm',
            disabled: busy || saving,
            onClick: () => load('refresh'),
          }, busy ? t('refreshing') : t('refresh')),
        ]),
        loading ? h('p', { key: 'loading', style: secondaryStyle }, t('loading')) : null,
        ...agents.map(agent => h(AgentCard, {
          key: agent.agent,
          agent,
          t,
          value: draft[agent.agent] || '',
          disabled: busy || saving || agent.connection !== 'connected',
          onChange: (value) => {
            setTouched(current => ({ ...current, [agent.agent]: true }))
            setDraft(current => ({ ...current, [agent.agent]: value }))
          },
        })),
        h('div', { key: 'save-row', style: rowStyle }, [
          Control({
            variant: 'primary',
            disabled: !ready || busy || saving,
            onClick: save,
          }, saving ? t('saving') : t('save')),
        ]),
      ])
    }

    function AgentCard({ agent, t, value, disabled, onChange }) {
      const groups = groupsFor(agent.models)
      const staleId = agent.selection === 'stale' || agent.selection === 'profile-stale' ? safeId(agent.effective) : ''
      const label = t(agent.agent) === agent.agent ? agent.agent : t(agent.agent)
      return h('section', { 'data-agent': agent.agent, style: cardStyle }, [
        h('div', { key: 'head', style: rowStyle }, [
          h('strong', { key: 'name' }, label),
          h('span', { key: 'state', style: statusStyle(agent.connection) }, t(agent.connection) === agent.connection ? t('unknown') : t(agent.connection)),
        ]),
        h('p', { key: 'selection', style: secondaryStyle }, t(agent.selection) === agent.selection ? t('unverified') : t(agent.selection)),
        staleId ? h('p', { key: 'stale', style: alertStyle }, staleId) : null,
        groups.length === 0 ? h('p', { key: 'empty', style: secondaryStyle }, t('empty')) : h('select', {
          key: 'select',
          'aria-label': label,
          value,
          disabled,
          onChange: (event) => onChange(event.target.value),
          style: selectStyle,
        }, [
          h('option', { key: 'cli', value: '' }, t('cli-default')),
          ...groups.map(group => h('optgroup', {
            key: group.id,
            label: t(group.id === 'alias' ? 'group-alias' : 'group-model'),
          }, group.items.map(item => h('option', { key: item.id, value: item.id }, optionLabel(item, t))))),
        ]),
        groups.some(group => group.id === 'alias') ? h('p', { key: 'alias', style: secondaryStyle }, t('alias-note')) : null,
        agent.excluded > 0 ? h('p', { key: 'excluded', style: secondaryStyle }, `${t('excluded')}：${agent.excluded}`) : null,
      ])
    }

    class Boundary extends (React?.Component || class {}) {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError() { return { error: true } }
      render() {
        if (this.state?.error) return h('p', { role: 'alert' }, zh['render-failed'])
        return this.props.children
      }
    }

    function Slot({ t, view }) {
      const text = typeof t === 'function' ? t : (key => zh[key] || key)
      if (view === 'summary' || view !== 'page') return text('summary')
      if (!React) return text('client-unavailable')
      return h(Boundary, null, h(Page, { t: text, ctx: Slot.ctx }))
    }

    function apply(ctx) {
      Slot.ctx = ctx
      try {
        const registerDictionaries = () => ctx.locale.register(NS, { zh, en })
        if (typeof ctx.effect === 'function') ctx.effect(registerDictionaries)
        else ctx.locale?.register?.(NS, { zh, en })
      } catch { /* A missing dictionary must not blank the host tools. */ }
      try {
        const register = () => ctx.slots.register({
          name: 'plugins.row.config',
          key: 'dsh-tr-bridge#tr-bridge',
          locale: NS,
        }, Slot)
        if (typeof ctx.slots?.inject === 'function') ctx.slots.inject('plugins.row.config', register)
        else register()
      } catch { /* The config slot stays absent. Host tools remain registered. */ }
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply,
    }
  },
})
