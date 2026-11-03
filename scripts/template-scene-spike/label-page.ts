/** Página única do rotulador: sem dependências, só DOM e fetch. */
export const LABEL_PAGE = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Rótulos do spike</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#f4f4f6;color:#222}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ccc;padding:8px 16px;z-index:5;display:flex;gap:16px;align-items:center}
h2{margin:24px 16px 8px}.item{background:#fff;margin:8px 16px;padding:12px;border-radius:8px;border:1px solid #ddd}
.item.done{border-color:#7a7}.imgs{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
figure{margin:0}figcaption{font-size:12px;color:#555}img{max-height:300px;max-width:360px;cursor:zoom-in;border:1px solid #bbb;background:#888}
.row{display:flex;gap:6px;align-items:center;margin:4px 0;flex-wrap:wrap}.row b{min-width:110px;font-size:13px}
button{padding:5px 10px;border:1px solid #999;border-radius:6px;background:#fafafa;cursor:pointer}
button.on{background:#2b6cb0;color:#fff;border-color:#2b6cb0}
#zoom{display:none;position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:10;overflow:auto;cursor:zoom-out}
#zoom img{max-width:none;max-height:none;cursor:zoom-out;border:0}
</style></head><body>
<header><strong id="count">carregando...</strong><label><input type="checkbox" id="only"> só pendentes</label><span id="msg"></span></header>
<main id="main"></main><div id="zoom"><img id="zimg"></div>
<script>
let items=[],labels={};
const $=(id)=>document.getElementById(id);
const OPTS=__OPTS__;
const complete=(k)=>Object.values(labels[k]||{}).every((v)=>v!==null);
function el(tag,props,...kids){const e=document.createElement(tag);Object.assign(e,props||{});kids.forEach((k)=>e.append(k));return e}
function render(){
  const main=$('main');main.replaceChildren();
  const done=items.filter((i)=>complete(i.key)).length;
  $('count').textContent=done+' de '+items.length+' completos';
  const only=$('only').checked;
  const names={A:'Bloco A e margem de 8%',C:'Bloco C (sobreposição)',B:'Bloco B (promoção e fallback)'};
  let last='';
  for(const it of items){
    if(only&&complete(it.key))continue;
    const grp=it.block;
    if(grp!==last){main.append(el('h2',{textContent:names[grp]}));last=grp}
    const card=el('div',{className:'item'+(complete(it.key)?' done':'')});
    card.append(el('strong',{textContent:it.title}),el('div',{textContent:it.request}));
    const imgs=el('div',{className:'imgs'});
    for(const im of it.images){const i=el('img',{src:'/img?p='+encodeURIComponent(im.path),loading:'lazy'});i.onclick=()=>{$('zimg').src=i.src;$('zoom').style.display='block'};imgs.append(el('figure',{},i,el('figcaption',{textContent:im.label})))}
    card.append(imgs);
    for(const f of it.fields){
      const row=el('div',{className:'row'},el('b',{textContent:f}));
      for(const v of OPTS[f]){const b=el('button',{textContent:v,className:labels[it.key][f]===v?'on':''});b.onclick=()=>save(it.key,f,v);row.append(b)}
      card.append(row);
    }
    main.append(card);
  }
}
async function save(key,field,value){
  const r=await fetch('/api/label',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key,field,value})});
  const j=await r.json();
  if(!r.ok){$('msg').textContent='Erro: '+j.error;return}
  labels[key]=j.entry;$('msg').textContent='gravado';const y=scrollY;render();scrollTo(0,y);
}
$('only').onchange=render;$('zoom').onclick=()=>{$('zoom').style.display='none'};
fetch('/api/items').then((r)=>r.json()).then((d)=>{items=d.items;labels=d.labels;render()});
</script></body></html>`;
