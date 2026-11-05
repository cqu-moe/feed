const BASE_HOST_SUFFIX='.cn-beijing.maas.aliyuncs.com';
const REQUEST_TIMEOUT_MS=15_000;
const OSS_REQUEST_TIMEOUT_MS=60_000;
const MAX_RESPONSE_BYTES=2*1024*1024;
const MAX_IMPORT_FILES=100;

const textEncoder=new TextEncoder();

export function createBailianClient(env){
  const apiKey=requiredEnv(env,'BAILIAN_API_KEY');
  const workspaceId=stringEnv(env,'BAILIAN_WORKSPACE_ID');
  if(!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(workspaceId))throw invalidRequest('Invalid Bailian workspace');
  const categoryId=stringEnv(env,'BAILIAN_CATEGORY_ID');
  const indexId=stringEnv(env,'BAILIAN_INDEX_ID');
  const searchServiceId=stringEnv(env,'BAILIAN_SEARCH_SERVICE_ID');
  const baseUrl=`https://${workspaceId}${BASE_HOST_SUFFIX}`;

  async function uploadFile({name,text}){
    const fileName=fileNameValue(name);
    const content=stringValue(text,'file text');
    const bytes=textEncoder.encode(content);
    if(bytes.length===0||bytes.length>8*1024*1024)
      throw invalidRequest('Bailian file text must be 1 to 8388608 bytes');

    const lease=await requestJson('/api/v1/connector/dash/applyFileUploadLease',{
      body:{
        category:categoryId,
        fileName,
        sizeBytes:String(bytes.length),
        contentMd5:await md5Base64(bytes),
      },
    });
    const leaseData=successData(lease,'Success','status');
    const upload=leaseData?.param;
    if(leaseData?.type!=='OSS.PreSignedUrl'||!isRecord(upload)
      ||upload.method!=='PUT'||typeof upload.url!=='string')
      throw providerResponseError('Invalid Bailian upload lease');
    const ossUrl=safeOssUrl(upload.url).href;
    const uploadHeaders=headerRecord(upload.headers);
    await rawFetch(ossUrl,{
      method:'PUT',
      headers:uploadHeaders,
      body:bytes,
      redirect:'manual',
      signal:AbortSignal.timeout(OSS_REQUEST_TIMEOUT_MS),
    },OSS_REQUEST_TIMEOUT_MS);
    return stringValue(leaseData.leaseId,'Bailian lease id');
  }

  async function registerFile({name,text,tags=[]}){
    const fileTags=tagsValue(tags);
    let leaseId;
    try{leaseId=await uploadFile({name,text});}
    catch(error){
      // addFile has not been issued, so retrying cannot register a second file.
      throw Object.assign(error,{registrationAttempted:false,stage:'upload'});
    }
    try{
      const registered=await requestJson('/api/v1/connector/dash/addFile',{
        body:{
          leaseId,
          category:categoryId,
          categoryType:'UNSTRUCTURED',
          parser:'AUTO_SELECT',
          tags:fileTags,
        },
      });
      const data=successData(registered,'Success','status');
      if(typeof data.fileId!=='string')
        throw providerResponseError('Invalid Bailian file id');
      return identifier(data.fileId,'Bailian file id');
    }catch(error){throw Object.assign(error,{stage:'register'});}
  }

  async function findFile({name,text}){
    const fileName=fileNameValue(name);
    const content=stringValue(text,'file text');
    const bytes=textEncoder.encode(content);
    const response=await requestJson('/api/v1/connector/dash/listFile',{
      body:{
        categoryId,
        fileName:fileName.replace(/\.[^.]+$/,''),
        maxResult:100,
      },
    });
    const files=successData(response,'Success','status')?.fileList;
    if(!Array.isArray(files))return null;
    const matches=files.filter(file=>isRecord(file)&&file.fileName===fileName
      &&file.sizeBytes===bytes.length);
    if(matches.length!==1)return null;
    const fileId=identifier(matches[0].fileId,'Bailian file id');
    const details=await requestJson('/api/v1/connector/dash/describeFile',{
      body:{fileId},
    });
    const data=successData(details,'Success','status');
    return data.fileId===fileId&&data.fileName===fileName
      &&data.sizeBytes===bytes.length&&data.category===categoryId
      ?fileId:null;
  }

  async function startImport(fileIds){
    const ids=identifiers(fileIds,'Bailian file id',MAX_IMPORT_FILES);
    const response=await requestJson('/api/v1/indices/rag/index/job/create',{
      body:{
        indexId,
        sourceType:'DATA_CENTER_FILE',
        docIds:ids,
      },
    });
    const data=successData(response,'Success','status_code');
    return identifier(data?.ingestionId,'Bailian import job id');
  }

  async function checkImport(jobId){
    const query=new URLSearchParams({
      index_id:indexId,
      job_id:identifier(jobId,'Bailian import job id'),
      page_number:'1',
      page_size:String(MAX_IMPORT_FILES),
    });
    const response=await requestJson(`/api/v1/indices/rag/index_job/status?${query}`,{
      method:'GET',
      body:undefined,
    });
    const data=successData(response,'Success','status_code');
    const rows=Array.isArray(data?.rows)?data.rows:[];
    const files=rows.map(row=>{
      if(!isRecord(row))throw providerResponseError('Invalid Bailian import status');
      return {
        fileId:identifier(row.doc_id,'Bailian file id'),
        state:fileImportState(row.status??row.code),
      };
    });
    if(data?.total_count!==files.length) throw providerResponseError('Invalid Bailian import pagination');
    return {state:importState(data?.ingestion_status,files),files};
  }

  async function removeDocument(fileId){
    const response=await requestJson('/api/v1/indices/rag/index/delete_file',{
      body:{index_id:indexId,doc_ids:[identifier(fileId,'Bailian file id')]},
    });
    requireRagSuccess(response,'Bailian document deletion failed');
  }

  async function removeFile(fileId){
    const response=await requestJson('/api/v1/connector/dash/deleteFile',{
      body:{fileId:identifier(fileId,'Bailian file id')},
    });
    requireConnectorSuccess(response,'Bailian file deletion failed');
  }

  async function search({query,tagGroups=[]}){
    const searchText=stringValue(query,'Bailian search query');
    if(textEncoder.encode(searchText).length>2048)
      throw invalidRequest('Bailian search query is too long');
    const groups=tagGroupsValue(tagGroups);
    const filters=groups.map(tags=>({tags}));
    const response=await requestJson('/api/v1/indices/knowledge/search',{
      body:{
        agent_id:searchServiceId,
        query:searchText,
        images:[],
        kb_search_configs:[{
          id:indexId,
          ...(filters.length?{search_filters:filters}:{}),
        }],
      },
    });
    if(response?.success!==true||response?.status!=='SUCCESS')
      throw providerResponseError('Bailian search request failed');
    const nodes=response?.data?.nodes;
    if(!Array.isArray(nodes))throw providerResponseError('Invalid Bailian search response');
    return nodes.map(node=>{
      const metadata=node?.metadata;
      if(!isRecord(node)||!isRecord(metadata))
        throw providerResponseError('Invalid Bailian search result');
      const content=stringValue(metadata.content,'Bailian search content');
      return {
        fileId:identifier(metadata.doc_id,'Bailian file id'),
        content,
        ...(typeof metadata.title==='string'&&metadata.title?{heading:metadata.title}:{})
      };
    });
  }

  async function requestJson(path,{method='POST',body}){
    const response=await rawFetch(baseUrl+path,{
      method,
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
      headers:{
        Authorization:`Bearer ${apiKey}`,
        'Content-Type':'application/json',
      },
      redirect:'manual',
      signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },REQUEST_TIMEOUT_MS);
    return responseJson(response);
  }

  async function rawFetch(url,init,timeoutMs){
    try{
      const response=await fetch(String(url),init);
      if(!response.ok)throw httpError(response.status);
      return response;
    }catch(error){
      if(error instanceof BailianError)throw error;
      throw normalizedTransportError(error,timeoutMs);
    }
  }

  async function responseJson(response){
    const bytes=await responseBytes(response);
    let payload;
    try{payload=JSON.parse(new TextDecoder().decode(bytes));}
    catch{throw providerResponseError('Invalid Bailian JSON response');}
    if(isRecord(payload)&&(payload.code==='Success'||payload.success===true&&payload.status==='SUCCESS'))return payload;
    throw businessError(payload);
  }

  async function responseBytes(response){
    const reader=response.body?.getReader();
    if(!reader)throw providerResponseError('Missing Bailian response body');
    const chunks=[];
    let received=0;
    try{
      for(;;){
        const {done,value}=await reader.read();
        if(done)break;
        if(!(value instanceof Uint8Array))
          throw providerResponseError('Missing Bailian response body');
        received+=value.byteLength;
        if(received>MAX_RESPONSE_BYTES)
          throw providerResponseError('Bailian response is too large');
        chunks.push(value);
      }
    }catch(error){
      await reader.cancel().catch(()=>{});
      throw error instanceof BailianError?error:providerResponseError('Invalid Bailian response body');
    }
    const bytes=new Uint8Array(received);
    let offset=0;
    for(const chunk of chunks){
      bytes.set(chunk,offset);
      offset+=chunk.byteLength;
    }
    return bytes;
  }

  return {registerFile,findFile,startImport,checkImport,removeDocument,removeFile,search};
}

function importState(status,files){
  if(files.length===0)return 'pending';
  if(status==='COMPLETED')
    return files.some(file=>file.state==='failed')?'failed':'done';
  if(files.some(file=>file.state==='failed'))return 'failed';
  return 'pending';
}

function fileImportState(value){
  if(value==='FINISH')return 'done';
  if(value==='PARSING'||value==='RUNNING'||value==='PENDING'||value==='INIT')return 'pending';
  if(value==='PARSER_ERROR'||value==='PARSE_FAILED'||value==='INSERT_ERROR'
    ||value==='PIPELINE_JOB_RETRY_IMPORT_ERROR'||value==='FAIL'||value==='FAILED')return 'failed';
  throw providerResponseError('Invalid Bailian file import state');
}


function tagGroupsValue(value){
  if(!Array.isArray(value))throw invalidRequest('Bailian tag groups must be an array');
  if(value.length>32)throw invalidRequest('Too many Bailian tag groups');
  return value.map(group=>{
    const tags=tagsValue(group);
    if(tags.length===0)throw invalidRequest('Empty Bailian tag groups are not allowed');
    return tags;
  });
}

function tagsValue(value){
  if(!Array.isArray(value))throw invalidRequest('Bailian tags must be an array');
  if(value.length>100)throw invalidRequest('Too many Bailian tags');
  const tags=value.map(tag=>{
    const text=stringValue(tag,'Bailian tag');
    if(text.length>32||!/^[-_a-zA-Z0-9\p{Script=Han}]+$/u.test(text))
      throw invalidRequest('Invalid Bailian tag');
    return text;
  });
  if(tags.some((tag,index)=>tags.indexOf(tag)!==index))
    throw invalidRequest('Duplicate Bailian tags are not allowed');
  if(tags.join('').length>700)
    throw invalidRequest('Combined Bailian tags are too long');
  return tags;
}

function identifiers(value,label,max){
  if(!Array.isArray(value)||value.length===0)
    throw invalidRequest(`${label}s must be a non-empty array`);
  if(value.length>max)throw invalidRequest(`Too many ${label}s`);
  return value.map(item=>identifier(item,label));
}

function identifier(value,label){
  if(typeof value!=='string'||!/^[A-Za-z0-9_.:-]{1,256}$/.test(value))
    throw invalidRequest(`Invalid ${label}`);
  return value;
}

function fileNameValue(value){
  const name=stringValue(value,'Bailian file name');
  if(name.length>256||/[\\/]/.test(name)||name==='.'||name==='..')
    throw invalidRequest('Invalid Bailian file name');
  return name;
}

function stringValue(value,label){
  if(typeof value!=='string')throw invalidRequest(`Invalid ${label}`);
  return value;
}

function stringEnv(env,name){
  const value=typeof env?.[name]==='string'?env[name]:'';
  return identifier(value,name.replace(/^BAILIAN_/,'Bailian ').toLowerCase());
}

function requiredEnv(env,name){
  const value=typeof env?.[name]==='string'?env[name]:'';
  if(!value||value.length>256||/[\r\n]/.test(value))
    throw invalidRequest(`Invalid ${name.replace(/^BAILIAN_/,'Bailian ').toLowerCase()}`);
  return value;
}

function successData(payload,successCode,statusField){
  // Connector examples return status_code; their field tables use numeric status.
  const status=typeof payload?.status==='number'?payload.status:payload?.status_code;
  if(payload?.code!==successCode||status!==200||payload.success===false||
    (typeof payload.status_code==='number'&&payload.status_code!==200)||
    (statusField==='status_code'&&payload.status==='FAILED'))
    throw businessError(payload);
  if(!isRecord(payload.data))throw providerResponseError('Invalid Bailian response data');
  return payload.data;
}

function requireRagSuccess(payload,message){
  if(payload?.code!=='Success'||payload?.status_code!==200
    ||payload?.success!==true||payload?.status!=='SUCCESS'||!isRecord(payload.data))
    throw providerResponseError(message);
}

function requireConnectorSuccess(payload,message){
  if(payload?.code!=='Success'||(payload.status??payload.status_code)!==200||!isRecord(payload.data)
    ||payload.success===false||(payload.status_code!==undefined&&payload.status_code!==200))
    throw providerResponseError(message);
}

function businessError(payload){
  const status=Number.isInteger(payload?.status)?payload.status:payload?.status_code;
  const error=providerResponseError('Bailian rejected the request');
  if(Number.isInteger(status)&&status>=400&&status<=599)error.status=status;
  // Persist only known categories; vendor messages can contain content or signed URLs.
  const message=[payload?.code,payload?.message].filter(v=>typeof v==='string').join(' ').slice(0,2000);
  const reason=[['checksum',/md5|checksum|digest|校验和/i],['tags',/\btag(?:s)?\b|标签/i],
    ['file_type',/extension|file.?type|文件类型|文件格式/i],['parser',/parser|解析器/i],
    ['category',/categor(?:y|ies)|类目/i],['lease',/lease|租约/i],
    ['permission',/permission|forbidden|accessdenied|unauthori|权限/i],
    ['invalid_parameter',/invalid.?parameter|invalid.?param|参数/i]].find(([,pattern])=>pattern.test(message));
  error.reason=reason?.[0]??'rejected';
  return error;
}

function headerRecord(value){
  if(!isRecord(value))throw providerResponseError('Invalid Bailian OSS headers');
  const headers={};
  for(const [name,headerValue] of Object.entries(value)){
    if(!isValidHeaderName(name)||!isValidHeaderValue(headerValue))
      throw providerResponseError('Invalid Bailian OSS headers');
    headers[name]=headerValue;
  }
  return headers;
}

function isValidHeaderName(value){
  return value.length>0&&value.length<=128&&/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/.test(value);
}

function isValidHeaderValue(value){
  return typeof value==='string'&&value.length<=2048&&!/[\r\n]/.test(value);
}

function safeOssUrl(value){
  let url;
  try{url=new URL(value);}
  catch{throw providerResponseError('Invalid Bailian OSS URL');}
  if(url.protocol!=='https:'||url.username||url.password
    ||!url.hostname.endsWith('.aliyuncs.com')||url.hostname==='aliyuncs.com')
    throw providerResponseError('Invalid Bailian OSS URL');
  return url;
}

async function md5Base64(bytes){
  const digest=new Uint8Array(await crypto.subtle.digest('MD5',bytes));
  let binary='';
  for(let index=0;index<digest.length;index+=0x8000)
    binary+=String.fromCharCode(...digest.subarray(index,index+0x8000));
  return btoa(binary);
}


function normalizedTransportError(error,timeoutMs){
  if(error instanceof BailianError)return error;
  if(error?.name==='TimeoutError'||error?.name==='AbortError')
    return timeoutError(timeoutMs);
  const cause=error instanceof TypeError?null:error;
  return new BailianError('Bailian network request failed','network',{cause});
}

function httpError(status){
  const error=new BailianError(`Bailian HTTP request failed: ${status}`,'http',{status});
  return error;
}

function timeoutError(timeoutMs){
  return new BailianError('Bailian request timed out','timeout',{timeoutMs});
}

function providerResponseError(message){
  return new BailianError(message,'response');
}

function invalidRequest(message){
  return new BailianError(message,'request');
}

class BailianError extends Error{
  constructor(message,kind,details={}){
    super(message);
    this.name='BailianError';
    this.kind=kind;
    Object.assign(this,details);
  }
}

function isRecord(value){
  return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
}
