import { useEffect, useRef, useState, type RefObject } from 'react';
import { Button, Input, ThemeMenu } from '@cqu-moe/ui';
import { ArrowDown, ArrowRight, Check, FileText, History, Paperclip, Rss, Search } from 'lucide-react';
import './landing.css';

// Public, fictional examples. The landing never reads a session or calls an API.
const notices = [
  { id: 'course', title: '关于开展本科生课程补选的通知', topic: '选课', date: '10月31日', text: '本学期课程补选工作即将开始。请同学们核对培养方案与个人课表，按通知要求完成课程选择。', file: '课程补选工作安排.pdf' },
  { id: 'exam', title: '关于期中考试安排的通知', topic: '考试', date: '10月30日', text: '本学期期中考试安排已发布。请同学们核对考试课程、时间和地点，提前做好准备。', file: '期中考试安排表.pdf' },
  { id: 'project', title: '关于大学生创新训练项目申报的通知', topic: '项目', date: '10月29日', text: '大学生创新训练项目申报工作现已启动。请有意申报的同学阅读项目要求，与指导教师沟通后准备申报材料。', file: '项目申报指南.pdf' },
  { id: 'exchange', title: '关于春季学期交换项目报名的通知', topic: '交流', date: '10月28日', text: '春季学期交换项目报名现已开放。请同学们关注申请条件、材料要求和报名流程。', file: '交换项目申请材料.pdf' },
];
type Notice = typeof notices[number];
type ArchiveView = 'text' | 'files' | 'history';
type DeliveryMode = 'digest' | 'immediate' | 'rss';

const questions = [
  ['需要什么账号？', '使用 CQU Moe 统一账号登录，并开通 Feed 访问权限，即可阅读已采集的通知与存档。'],
  ['现在可以看哪些通知？', '可以阅读已接入并验证的校园通知栏目。当前可用的站点与栏目，以登录后的来源列表为准。'],
  ['原文和附件怎样保存？', 'Feed 按采集结果留存正文、可获取的附件和版本记录。具体材料是否已保存，可在通知详情中查看；通知要求仍以原站发布为准。'],
  ['邮件和 RSS 有什么区别？', '邮件可以选择每日摘要或即时发送。私有 RSS 可添加到阅读器，提供标题、摘要和版本链接；阅读正文和附件仍需登录。'],
  ['新栏目会自动加入订阅吗？', '不会。按站点创建订阅时，只包含当时已选择的栏目；之后接入的新栏目需要手动加入。'],
  ['可以暂停或取消订阅吗？', '可以在「我的订阅」中暂停、编辑或删除订阅，也可以单独管理邮件模式和私有 RSS 链接。'],
];

function usePageMotion(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        if (preference.matches) continue;
        const element = entry.target as HTMLElement;
        element.style.setProperty('--fl-delay', `${Number(element.dataset.delay || 0)}ms`);
        element.classList.add('fl-arrived');
      }
    }, { threshold: 0.1 });
    node.querySelectorAll('[data-reveal]').forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [root]);
}

function Brand() {
  return <a className="fl-brand" href="#landing-home" aria-label="CQU Feed 首页"><span className="fl-logo" aria-hidden="true" />CQU Feed</a>;
}

function NoticeList({ onSelect }: { onSelect: (notice: Notice) => void }) {
  const [query, setQuery] = useState('');
  const matches = notices.filter(notice => `${notice.title} ${notice.topic}`.includes(query.trim()));
  return <div className="fl-inbox" data-ui="notice-list">
    <div className="fl-inbox-title"><strong>教务处通知</strong><span>内容示例</span></div>
    <label className="fl-search"><Search aria-hidden="true" /><span className="fl-visually-hidden">搜索通知示例</span>
      <Input aria-label="搜索通知示例" placeholder="试试搜索「选课」" value={query} onChange={event => setQuery(event.target.value)} />
    </label>
    <div className="fl-keywords" aria-label="搜索示例">{['全部', '选课', '考试'].map(keyword => <button type="button" key={keyword}
      aria-pressed={query === (keyword === '全部' ? '' : keyword)} onClick={() => setQuery(keyword === '全部' ? '' : keyword)}>{keyword}</button>)}</div>
    <div className="fl-inbox-rows" aria-live="polite">
      {matches.length ? matches.map(notice => <button type="button" className="fl-notice" key={notice.id} onClick={() => onSelect(notice)}>
        <span><span className="fl-notice-meta">{notice.topic}<time>{notice.date}</time></span><strong>{notice.title}</strong></span><ArrowRight aria-hidden="true" />
      </button>) : <div className="fl-search-empty"><p>没有找到这条通知</p><button type="button" onClick={() => setQuery('')}>查看全部示例</button></div>}
    </div>
    <div className="fl-inbox-foot"><span>{matches.length} 条通知示例</span><span><Paperclip aria-hidden="true" />含正文与附件</span></div>
  </div>;
}

function ArchiveDocument({ notice, view, file }: { notice: Notice; view: ArchiveView; file: string }) {
  return <div className="fl-document" data-ui="archived-document" key={`${notice.id}-${view}`}>
    <div className="fl-document-meta"><span>重庆大学教务处</span><span>{view === 'history' ? '版本示例' : '存档示例'}</span></div>
    <h3>{notice.title}</h3>
    {view === 'text' ? <div className="fl-document-copy"><p>各学院、相关同学：</p><p>{notice.text}</p><p>具体工作安排和材料要求请查阅随通知发布的附件。</p></div>
      : view === 'files' ? <div className="fl-document-copy"><p className="fl-file-name"><FileText aria-hidden="true" />{file}</p><p>附件内容示例</p>
        <dl className="fl-file-content"><div><dt>办理事项</dt><dd>{notice.topic}相关安排</dd></div><div><dt>材料提交</dt><dd>按通知要求准备</dd></div><div><dt>具体时间</dt><dd>以原站发布为准</dd></div></dl></div>
        : <div className="fl-version-list"><div><History aria-hidden="true" /><p><strong>更新后的版本</strong><span>{notice.date} · 附件已更新</span></p><span>当前</span></div>
          <div><FileText aria-hidden="true" /><p><strong>首次存档</strong><span>{notice.date} · 正文与附件</span></p></div><p>每次保存的版本，都能单独回看。</p></div>}
    <div className="fl-document-footer"><span>正文、附件与版本分别留存</span><Check aria-hidden="true" /></div>
  </div>;
}

function AttachmentList({ notice, onOpen }: { notice: Notice; onOpen: (file: string) => void }) {
  return <div className="fl-attachments" data-ui="attachment-list">
    <div className="fl-attachment-heading"><strong>相关附件</strong><span>2 个示例文件</span></div>
    {[notice.file, '申请材料填写说明.pdf'].map(file => <button type="button" onClick={() => onOpen(file)} key={file}>
      <FileText aria-hidden="true" /><span>{file}<small>PDF 文档 · 预览示例</small></span><ArrowRight aria-hidden="true" />
    </button>)}
    <p>原件留在通知旁，回看时不用重新寻找。</p>
  </div>;
}

const deliveryLabels: Record<DeliveryMode, string> = { digest: '每日摘要', immediate: '即时邮件', rss: '私有 RSS' };
function DeliveryPreview({ notice, mode }: { notice: Notice; mode: DeliveryMode }) {
  const items = mode === 'immediate' ? [notice] : [notice, ...notices.filter(item => item.id !== notice.id).slice(0, 2)];
  return <div className="fl-delivery-preview" data-ui="delivery-preview" aria-live="polite">
    <div className="fl-mail-from"><span className="fl-logo" aria-hidden="true" /><div><strong>CQU Feed</strong><span>{mode === 'rss' ? '教务处通知 · 阅读器示例' : '教务处通知 · 邮件示例'}</span></div></div>
    <h3>{mode === 'digest' ? '你关注的通知，整理好了。' : mode === 'immediate' ? '你关注的栏目有新通知。' : '在阅读器里，接着读。'}</h3>
    <p>{mode === 'digest' ? '这一封，收好今天的更新。' : mode === 'immediate' ? '采集到新内容后发送邮件。' : '标题、摘要和版本链接随更新送达。'}</p>
    <div className="fl-mail-items">{items.map(item => <div key={item.id}><span>{item.date} · 教务处</span><strong>{item.title}</strong><p>{item.text}</p></div>)}</div>
    <div className="fl-mail-bottom">{mode === 'rss' ? <Rss aria-hidden="true" /> : <Check aria-hidden="true" />}<span>{deliveryLabels[mode]}{mode === 'digest' ? ` · ${items.length} 条通知示例` : ' · 内容示例'}</span></div>
  </div>;
}

export function FeedLanding({ loginHref }: { loginHref: string }) {
  const root = useRef<HTMLDivElement>(null);
  const archiveHeading = useRef<HTMLHeadingElement>(null);
  const [notice, setNotice] = useState(notices[0]);
  const [archiveView, setArchiveView] = useState<ArchiveView>('text');
  const [file, setFile] = useState(notices[0].file);
  const [mode, setMode] = useState<DeliveryMode>('digest');
  usePageMotion(root);
  function selectNotice(next: Notice) {
    setNotice(next); setFile(next.file); setArchiveView('text');
    archiveHeading.current?.focus({ preventScroll: true });
    document.getElementById('landing-archive')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  return <div className="fl-page" id="landing-home" ref={root}>
    <a className="fl-skip" href="#landing-main">跳到正文</a>
    <header className="fl-header fl-frame"><Brand /><nav aria-label="Feed 首页导航"><a href="#landing-archive">存档</a><a href="#landing-delivery">订阅</a><a href="#landing-questions">常见问题</a></nav>
      <div className="fl-header-actions"><ThemeMenu /><a className="fl-login" href={loginHref}>登录</a></div>
    </header>
    <main id="landing-main">
      <section className="fl-hero fl-frame" aria-labelledby="feed-title">
        <div className="fl-hero-copy"><h1 id="feed-title" data-reveal>重大通知，<br />在这里汇合。</h1>
          <p className="fl-lead" data-reveal data-delay="70">集中阅读教务通知，保存原文与附件，把关心的更新送到邮箱。</p>
          <div className="fl-hero-action" data-reveal data-delay="140"><Button asChild className="fl-primary" size="lg"><a href={loginHref}>登录并开始阅读 <ArrowRight aria-hidden="true" /></a></Button>
            <a href="#landing-archive">看看如何保存</a></div>
          <p className="fl-access" data-reveal data-delay="210">使用 CQU Moe 统一账号，需开通 Feed 权限。</p>
        </div>
        <div className="fl-hero-stage" data-reveal="picture"><div className="fl-stage-shutter" aria-hidden="true" /><NoticeList onSelect={selectNotice} /></div>
        <p className="fl-hero-tail" data-reveal><span>从一条通知开始，<br />把要用的信息留在身边。</span><a href="#landing-archive" aria-label="继续了解通知存档"><ArrowDown aria-hidden="true" /></a></p>
      </section>

      <section id="landing-archive" className="fl-archive fl-frame fl-section" aria-labelledby="archive-title">
        <div className="fl-archive-intro"><h2 id="archive-title" ref={archiveHeading} tabIndex={-1} data-reveal>通知背后的材料，<br />也一起留下。</h2>
          <p data-reveal>正文、附件和历史版本放在同一处。下次需要核对时，沿着这条通知就能找到。</p>
          <div className="fl-output-index" aria-label="选择存档预览">{([
            ['text', '阅读正文', '集中阅读已保存的内容'], ['files', '查看附件', '材料跟着通知一起留存'], ['history', '对照版本', '回看不同时间保存的内容'],
          ] as const).map(([id, label, description], index) => <button type="button" key={id} aria-pressed={archiveView === id} onClick={() => setArchiveView(id)} data-reveal data-delay={index * 70}>
            <span>{label}</span><small>{description}</small></button>)}</div>
          <p className="fl-source-note" data-reveal>内容以原站发布为准。</p>
        </div>
        <div className="fl-archive-stage"><div data-reveal="picture"><ArchiveDocument notice={notice} view={archiveView} file={file} /></div>
          <div data-reveal="picture" data-delay="90"><AttachmentList notice={notice} onOpen={nextFile => { setFile(nextFile); setArchiveView('files'); }} /></div></div>
      </section>

      <section id="landing-delivery" className="fl-delivery fl-frame fl-section" aria-labelledby="delivery-title">
        <div className="fl-delivery-stage" data-reveal="picture"><DeliveryPreview notice={notice} mode={mode} /></div>
        <div className="fl-delivery-copy"><h2 id="delivery-title" data-reveal>按你的节奏，<br />接收更新。</h2><p data-reveal>选好关注的栏目，再决定怎么接收。试着切换方式，看看通知会如何送达。</p>
          <div className="fl-delivery-options">{([
            ['digest', '每天，一封摘要', '把一天的更新整理成一封邮件，留到方便的时候读。'],
            ['immediate', '有更新，就发邮件', '关注需要及时了解的栏目，采集到新通知后发送。'],
            ['rss', '也可以，在阅读器里', '添加私有 RSS，让通知出现在你习惯的阅读器中。'],
          ] as const).map(([id, title, description], index) => <button type="button" key={id} aria-pressed={mode === id} onClick={() => setMode(id)}
            data-reveal data-delay={index * 70}><span>{title}<Check aria-hidden="true" /></span><p>{description}</p></button>)}</div>
          <a className="fl-text-action" href="/auth/login?next=%2Fsubscriptions" data-reveal>登录并设置订阅</a>
        </div>
      </section>

      <section id="landing-questions" className="fl-faq fl-frame fl-section" aria-labelledby="questions-title"><div><h2 id="questions-title" data-reveal>开始之前</h2><p data-reveal>关于来源、账号与接收方式。</p></div>
        <div className="fl-faq-list">{questions.map(([question, answer], index) => <details name="feed-questions" key={question} data-reveal data-delay={Math.min(index * 70, 210)}>
          <summary>{question}<span aria-hidden="true" className="fl-plus" /></summary><p>{answer}</p></details>)}</div>
      </section>
    </main>
    <footer className="fl-footer"><div className="fl-frame"><a href="#landing-home" className="fl-wordmark" aria-label="CQU Feed 回到顶部" data-reveal>CQU Feed</a>
      <div className="fl-footer-columns"><div><p data-reveal>通知有处可读，<br />材料有处可寻。</p><Button asChild className="fl-footer-action" data-reveal><a href={loginHref}>登录并开始阅读</a></Button></div>
        <nav aria-label="页脚导航" data-reveal><a href="#landing-archive">正文与附件</a><a href="#landing-delivery">邮件与 RSS</a><a href="#landing-questions">常见问题</a></nav>
        <div className="fl-footer-note" data-reveal><p>CQU Moe · 重大通知存档</p><p>通知要求以原站发布为准。</p><p>本页通知与附件为演示内容。</p></div></div>
      <div className="fl-footer-bottom"><span>为每次需要回看的时刻。</span><a href="#landing-home">回到顶部</a></div>
    </div></footer>
  </div>;
}
