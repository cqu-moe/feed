import {exportJWK,generateKeyPair,SignJWT} from 'jose';

// External Auth adapter for business tests. The Feed BFF still executes its real
// login transaction, nonce/JWT verification, encrypted session and introspection.
export function oauthProvider({feedOrigin='https://feed.test',authOrigin='https://auth.test'}={}){
  const clientId='feed-test-client',clientSecret='feed-test-secret',codes=new Map(),tokens=new Map();
  const keys=generateKeyPair('EdDSA',{crv:'Ed25519',extractable:true});
  let access=true;
  let subject='test-user';
  return {
    bindings:{AUTH_BASE_URL:authOrigin,FEED_AUTH_CLIENT_ID:clientId,FEED_AUTH_CLIENT_SECRET:clientSecret,FEED_SESSION_ENCRYPTION_KEY:'test-session-encryption-key'},
    setAccess(value){access=value;},
    setSubject(value){subject=value;},
    async fetch(request){
      const url=new URL(request.url);
      if(url.pathname.endsWith('/authorize')){
        const code=crypto.randomUUID();
        codes.set(code,Object.fromEntries(url.searchParams));
        const callback=new URL('/auth/callback',feedOrigin);
        callback.searchParams.set('code',code);callback.searchParams.set('state',url.searchParams.get('state'));
        return Response.redirect(callback,302);
      }
      if(url.pathname.endsWith('/jwks')){
        const jwk=await exportJWK((await keys).publicKey);
        return Response.json({keys:[{...jwk,kid:'test-auth',alg:'EdDSA',use:'sig'}]});
      }
      if(url.pathname.endsWith('/token')){
        const form=new URLSearchParams(await request.text()),code=codes.get(form.get('code'));
        const challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(form.get('code_verifier')))).toString('base64url');
        if(!code||challenge!==code.code_challenge||request.headers.get('Authorization')!=='Basic '+btoa(clientId+':'+clientSecret))return Response.json({error:'invalid_grant'},{status:400});
        codes.delete(form.get('code'));
        const token=crypto.randomUUID();tokens.set(token,subject);
        const jwt=await new SignJWT({nonce:code.nonce}).setProtectedHeader({alg:'EdDSA',kid:'test-auth'})
          .setIssuer(authOrigin+'/api/auth').setAudience(clientId).setSubject(subject).setIssuedAt().setExpirationTime('10m').sign((await keys).privateKey);
        return Response.json({access_token:token,token_type:'Bearer',expires_in:3600,id_token:jwt});
      }
      if(url.pathname.endsWith('/userinfo'))return Response.json({sub:tokens.get(request.headers.get('Authorization')?.slice(7)),name:'测试读者'});
      if(url.pathname.endsWith('/introspect')){
        const sub=tokens.get(new URLSearchParams(await request.text()).get('token'));
        return Response.json(sub?{active:true,sub,sid:'test-session',client_id:clientId,exp:Math.floor(Date.now()/1000)+3600,caps:{feed:{access}}}:{active:false});
      }
      return new Response('Not found',{status:404});
    },
  };
}

export async function login(mf,provider,subject){
  if(subject)provider.setSubject(subject);
  const start=await mf.dispatchFetch('https://feed.test/auth/login',{redirect:'manual'});
  if(start.status!==303)throw new Error('Login start failed: '+await start.text());
  const transactionCookie=start.headers.getSetCookie().find(value=>value.startsWith('__Host-feed_login='))?.split(';')[0];
  const auth=await provider.fetch(new Request(start.headers.get('Location')));
  const callback=await mf.dispatchFetch(auth.headers.get('Location'),{redirect:'manual',headers:{Cookie:transactionCookie}});
  const session=callback.headers.getSetCookie().find(value=>value.startsWith('__Host-feed_session='))?.split(';')[0];
  if(!session)throw new Error('Login callback failed: '+await callback.text());
  return session;
}
