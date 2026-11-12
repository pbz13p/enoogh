// Enoogh 一诺：离线也能打开。先走网络（保证总是最新版），断网时用上次缓存的页面。
var C='enoogh-v1', CORE=['/','/index.html','/manifest.webmanifest','/icons/icon-192.png','/icons/apple-touch-icon.png','/icons/favicon-32.png'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(C).then(function(c){return c.addAll(CORE);}).then(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==C;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('fetch',function(e){
  var r=e.request; if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return;
  e.respondWith(fetch(r).then(function(res){if(res&&res.ok){var cp=res.clone();caches.open(C).then(function(c){c.put(r,cp);});}return res;})
    .catch(function(){return caches.match(r).then(function(m){return m||(r.mode==='navigate'?caches.match('/index.html'):undefined);});}));
});
