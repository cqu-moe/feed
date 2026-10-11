import {useEffect,useRef,useState} from 'react';
import {useParams} from 'react-router';
import {Button,PageState} from '@cqu-moe/ui';
import {ChevronLeft,ChevronRight,Download,Minus,Plus} from 'lucide-react';
import {Document,Page,pdfjs} from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).toString();
const options={cMapUrl:'/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/pdfjs/standard_fonts/',wasmUrl:'/pdfjs/wasm/',isEvalSupported:false};

export default function PdfReader(){
  const {id='',filename=''}=useParams();
  const container=useRef<HTMLDivElement>(null);
  const [width,setWidth]=useState(640),[scale,setScale]=useState(1),[pages,setPages]=useState(0),[page,setPage]=useState(1);
  useEffect(()=>{
    const element=container.current;if(!element)return;
    const observer=new ResizeObserver(entries=>setWidth(Math.max(180,entries[0].contentRect.width-24)));
    observer.observe(element);return()=>observer.disconnect();
  },[]);
  const valid=/^[a-f0-9]{24}$/.test(id)&&/^attachment-\d+\.pdf$/.test(filename);
  if(!valid)return <PageState state="not-found" title="未找到 PDF" description="请从通知附件列表打开文件。"/>;
  const file=`/api/files/${id}/${filename}`;
  return <main className="feed-reader" aria-label="已存档的 PDF 阅读器">
    <div className="feed-reader-toolbar" role="toolbar" aria-label="PDF 翻页和缩放">
      <Button variant="outline" size="sm" aria-label="上一页" disabled={page<=1} onClick={()=>setPage(page-1)}><ChevronLeft aria-hidden="true"/></Button>
      <span aria-live="polite">{page} / {pages||'—'}</span>
      <Button variant="outline" size="sm" aria-label="下一页" disabled={!pages||page>=pages} onClick={()=>setPage(page+1)}><ChevronRight aria-hidden="true"/></Button>
      <Button variant="outline" size="sm" aria-label="缩小" disabled={scale<=0.6} onClick={()=>setScale(Math.max(.6,scale-.2))}><Minus aria-hidden="true"/></Button>
      <Button variant="outline" size="sm" aria-label="放大" disabled={scale>=2} onClick={()=>setScale(Math.min(2,scale+.2))}><Plus aria-hidden="true"/></Button>
      <Button asChild variant="outline" size="sm"><a href={`${file}?download=1`}><Download aria-hidden="true"/>下载</a></Button>
    </div>
    <div className="feed-reader-document" ref={container}>
      <Document file={file} options={options} onLoadSuccess={({numPages})=>{setPages(numPages);setPage(1);}} onItemClick={({pageNumber})=>setPage(pageNumber)}
        loading={<p role="status">正在读取已存档的 PDF…</p>}
        error={<PageState state="error" title="PDF 暂时无法预览" description="请确认登录仍有效，或下载原文件阅读。" action={<Button asChild><a href={`${file}?download=1`}>下载 PDF</a></Button>}/>}
        externalLinkTarget="_blank" externalLinkRel="noopener noreferrer">
        <Page pageNumber={page} width={width*scale} renderTextLayer renderAnnotationLayer loading={<p role="status">正在呈现页面…</p>}/>
      </Document>
    </div>
  </main>;
}
