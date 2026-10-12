import {PDF_TEXT_UNAVAILABLE} from './pdf-text.mjs';

const hashPattern=/^[a-f0-9]{64}$/;

export function aggregateOcrProjection(entries){
  validateEntries(entries);
  const models=entries.map(entry=>entry.model).filter(value=>typeof value==='string'&&value);
  return {
    v:1,
    kind:'body_ocr_projection',
    model:models[0]??null,
    updatedAt:entries.reduce((latest,entry)=>entry.updatedAt&&entry.updatedAt>latest?entry.updatedAt:latest,null),
    inputs:entries.map(entry=>({
      slotKey:entry.slotKey,inputHash:entry.inputHash,resultHash:entry.resultHash,filename:entry.filename,
      model:entry.model??null,updatedAt:entry.updatedAt??null,totalPages:entry.pages.length,pages:entry.pages,
    })),
  };
}

export function validateOcrProjection(output,requirements){
  if(output?.v!==1||output.kind!=='body_ocr_projection'||!Array.isArray(output.inputs))
    throw new Error('Current OCR projection identity is invalid');
  const expected=new Map(requirements.map(requirement=>[requirement.slotKey,requirement]));
  if(output.inputs.length!==expected.size)throw new Error('Current OCR projection inputs are incomplete');
  for(const entry of output.inputs){
    const requirement=expected.get(entry?.slotKey);
    if(!requirement||entry.inputHash!==requirement.inputHash||entry.filename!==requirement.filename)
      throw new Error('Current OCR projection identity is invalid');
  }
  validateEntries(output.inputs);
  return output;
}

export function flattenOcrEntries(entries){
  validateEntries(entries);
  const pages=[];
  for(const entry of entries){
    for(const page of entry.pages){
      pages.push({
        page:page.index+1,
        filename:entry.filename,
        source:page.source==='native'?'native':'ocr',
        markdown:String(page.markdown??page.text??''),
        text:String(page.text??''),
      });
    }
  }
  return pages;
}

export function applyOcrEntries(text,entries){
  validateEntries(entries);
  let result=text;
  for(const entry of entries){
    const recognized=entry.pages.map(page=>String(page.text??'').trim()).filter(Boolean).join('\n\n');
    if(result.includes(PDF_TEXT_UNAVAILABLE))result=result.replace(PDF_TEXT_UNAVAILABLE,recognized);
    else result=[result,recognized].filter(Boolean).join('\n\n');
  }
  return result;
}

function validateEntries(entries){
  if(!Array.isArray(entries)||!entries.length)throw new Error('Current OCR projection inputs are invalid');
  const slots=new Set();
  for(const entry of entries){
    if(!entry||typeof entry.slotKey!=='string'||!entry.slotKey||slots.has(entry.slotKey)
      ||!hashPattern.test(entry.inputHash??'')||!hashPattern.test(entry.resultHash??'')
      ||typeof entry.filename!=='string'||!Array.isArray(entry.pages)||!entry.pages.length)
      throw new Error('Current OCR projection inputs are invalid');
    slots.add(entry.slotKey);
    for(const page of entry.pages){
      if(!page||typeof page!=='object'||!Number.isSafeInteger(page.index)||page.index<0
        ||typeof page.text!=='string'||typeof page.markdown!=='string'||!['native','ocr'].includes(page.source))
        throw new Error('Current OCR projection pages are invalid');
    }
  }
}
