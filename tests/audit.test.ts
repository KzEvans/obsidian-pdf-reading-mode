import test from 'node:test';
import assert from 'node:assert/strict';
import { auditNativeText } from '../src/audit';
import { normalizeContentList } from '../src/normalize';

test('native source fills an empty paragraph and restores an omitted chemical subscript in a heading', async () => {
  const doc = normalizeContentList([
    {type:'text',text:'ZrO',text_level:1,page_idx:0,bbox:[50,50,400,220]},
    {type:'text',text:'',page_idx:0,bbox:[50,300,900,600]},
  ],'hash','test',1);
  const items = [
    {str:'ZrO',width:25,height:14,transform:[14,0,0,14,10,84]},
    {str:'2',width:5,height:9,transform:[9,0,0,9,35,80]},
    {str:'Native evidence preserves the original scientific paragraph and its meaning without a model rewriting the supplied source text.',width:165,height:10,transform:[10,0,0,10,10,52]},
  ];
  const pdf = {numPages:1,getPage:async()=>({getTextContent:async()=>({items}),getViewport:()=>({width:200,height:100,scale:1,convertToViewportPoint:(x:number,y:number)=>[x,100-y]})})};
  await auditNativeText(pdf,doc);
  assert.equal(doc.blocks[0]?.text,'ZrO<sub>2</sub>');
  assert.match(doc.blocks[1]!.text,/Native evidence preserves/);
  assert.ok(!doc.warnings.some(warning=>warning.includes('没有可显示内容')));
});

test('scientific inline math is kept when the cloud paragraph has actual content', async () => {
  const original = 'The permittivity is $\\varepsilon_r$ and the original expression must stay intact.';
  const doc = normalizeContentList([{type:'text',text:original,page_idx:0,bbox:[0,0,1000,1000]}],'hash','test',1);
  const pdf={numPages:1,getPage:async()=>({getTextContent:async()=>({items:[{str:'The native source has permittivity and a formula rendered with separately positioned glyphs and explanatory symbols.',width:180,height:10,transform:[10,0,0,10,0,80]}]}),getViewport:()=>({width:200,height:100,scale:1,convertToViewportPoint:(x:number,y:number)=>[x,100-y]})})};
  await auditNativeText(pdf,doc);
  assert.equal(doc.blocks[0]?.text,original);
});

const nativeItem = (str: string, x = 10, width = 180) => ({str,width,height:10,transform:[10,0,0,10,x,80]});
const pdfFromItems = (pages: ReturnType<typeof nativeItem>[][]) => ({
  numPages:pages.length,
  getPage:async(number:number)=>({
    getTextContent:async()=>({items:pages[number-1]}),
    getViewport:()=>({width:200,height:100,scale:1,convertToViewportPoint:(x:number,y:number)=>[x,100-y]}),
  }),
});

test('empty second-column layout fragment already contained in cloud prose merges sources without duplicating text', async () => {
  const tail = 'The dielectric elastomer shows large reversible deformation with high efficiency and low driving voltage across repeated actuation cycles.';
  const full = 'An earlier part of this paragraph describes the specimen. ' + tail;
  const doc = normalizeContentList([
    {type:'text',text:full,page_idx:0,bbox:[0,0,470,350]},
    {type:'text',text:'',page_idx:0,bbox:[500,0,1000,350]},
  ],'hash','test',1);
  await auditNativeText(pdfFromItems([[nativeItem('An earlier part of this paragraph describes the specimen.',10,80),nativeItem(tail,105,90)]]),doc);
  assert.equal(doc.blocks.length,1);
  assert.equal(doc.blocks[0]?.text,full);
  assert.equal(doc.blocks[0]?.sources.length,2);
  assert.ok(!doc.warnings.some(warning=>warning.includes('没有可显示内容')));
});

test('adjacent-page continuation deduplicates across publisher blocks and keeps original page locations', async () => {
  const tail = 'The breakdown strength increases with pre-stretch and the actuator retains its high deformation and mechanical integrity under the applied voltage.';
  const full = 'The previous source page begins this paragraph. ' + tail;
  const doc = normalizeContentList([
    {type:'text',text:full,page_idx:0,bbox:[0,700,500,1000]},
    ...Array.from({length:10},(_,i)=>({type:'header',text:`Publisher header ${i}`,page_idx:0})),
    {type:'text',text:'',page_idx:1,bbox:[0,0,1000,350]},
  ],'hash','test',2);
  await auditNativeText(pdfFromItems([[nativeItem('The previous source page begins this paragraph and the source contains additional explanatory wording for native evidence.')],[nativeItem(tail)]]),doc);
  assert.equal(doc.blocks.filter(block=>block.kind==='paragraph').length,1);
  assert.deepEqual(doc.blocks[0]?.sources.map(source=>source.page),[1,2]);
  assert.equal(doc.blocks[0]?.text,full);
  assert.deepEqual(doc.warnings,[]);
});

test('a neighboring native span repairs omitted ff ligatures and preserves surrounding cloud math', async () => {
  const tail='The different films are sufficiently robust to maintain high efficiency after the load is switched off and the baffles stabilize repeated actuation cycles.';
  const prefix='The original expression $K = 2$ explains the earlier result. ';
  const suffix=' The following expression $M = 7$ stays exact.';
  const doc=normalizeContentList([
    {type:'text',text:prefix+tail.replaceAll('ff','f')+suffix,page_idx:0,bbox:[0,0,470,200]},
    {type:'text',text:'',page_idx:0,bbox:[0,220,470,400]},
  ],'hash','test',1);
  const item={...nativeItem(tail,10,80),transform:[10,0,0,10,10,70]};
  await auditNativeText(pdfFromItems([[nativeItem('The earlier region has its own original scientific expression and explanatory prose.',10,80),item]]),doc);
  assert.equal(doc.blocks.length,1);
  assert.equal(doc.blocks[0]?.text,prefix+tail+suffix);
  assert.equal(doc.blocks[0]?.sources.length,2);
  const once=JSON.stringify(doc);
  await auditNativeText(pdfFromItems([[nativeItem('The earlier region has its own original scientific expression and explanatory prose.',10,80),item]]),doc);
  assert.equal(JSON.stringify(doc),once);
});

test('omitted ff in a cross-column continuation is corrected from its unique native source', async () => {
  const tail='The network can be remolded at a sufficiently high temperature while the number of covalent cross-links remains the same at all times.';
  const prefix='Earlier cloud wording and the expression $E = 3$ remain intact. ';
  const doc=normalizeContentList([
    {type:'text',text:prefix+tail.replace('sufficiently','suficiently'),page_idx:0,bbox:[0,0,470,350]},
    {type:'text',text:'',page_idx:0,bbox:[500,0,1000,350]},
  ],'hash','test',1);
  await auditNativeText(pdfFromItems([[nativeItem('Earlier native wording occupies the left column.',10,80),nativeItem(tail,105,90)]]),doc);
  assert.equal(doc.blocks.length,1);
  assert.equal(doc.blocks[0]?.text,prefix+tail);
  assert.equal(doc.blocks[0]?.sources.length,2);
});

test('omitted ff in an adjacent-page continuation corrects only the native matched tail', async () => {
  const tail='Stretching is sufficiently low for the network to survive repeated strain cycles while the measured high-rate curves agree with the predicted mechanical response.';
  const prefix='The preceding page contains cloud wording and $\\sigma = 6$. ';
  const doc=normalizeContentList([
    {type:'text',text:prefix+tail.replace('sufficiently','suficiently'),page_idx:0,bbox:[500,700,1000,1000]},
    {type:'text',text:'',page_idx:1,bbox:[0,0,470,350]},
  ],'hash','test',2);
  await auditNativeText(pdfFromItems([
    [nativeItem('The preceding native page begins a paragraph with its original wording and a formula before the continuation on the following page.')],
    [nativeItem(tail,10,80)],
  ]),doc);
  assert.equal(doc.blocks.length,1);
  assert.equal(doc.blocks[0]?.text,prefix+tail);
  assert.deepEqual(doc.blocks[0]?.sources.map(source=>source.page),[1,2]);
});

test('a real repeated native passage retains both layout regions', async () => {
  const tail='The network can be remolded at a sufficiently high temperature while the number of covalent cross-links remains the same at all times.';
  const doc=normalizeContentList([
    {type:'text',text:tail.replace('sufficiently','suficiently'),page_idx:0,bbox:[0,0,470,350]},
    {type:'text',text:'',page_idx:0,bbox:[500,0,1000,350]},
  ],'hash','test',1);
  await auditNativeText(pdfFromItems([[nativeItem(tail,10,80),nativeItem(tail,105,90)]]),doc);
  assert.equal(doc.blocks.length,2);
  assert.equal(doc.blocks[1]?.text,tail);
});

test('geometric region order can prove an overlap when raw PDF item order is different', async () => {
  const tail='The network can be remolded at a sufficiently high temperature while the number of covalent cross-links remains the same at all times.';
  const split=tail.indexOf('while');
  const prefix='The earlier cloud wording is preserved. ';
  const doc=normalizeContentList([
    {type:'text',text:prefix+tail,page_idx:0,bbox:[0,0,470,400]},
    {type:'text',text:'',page_idx:0,bbox:[500,0,1000,400]},
  ],'hash','test',1);
  const second={...nativeItem(tail.slice(split),105,90),transform:[10,0,0,10,105,70]};
  await auditNativeText(pdfFromItems([[nativeItem('The left column contains the earlier native wording.',10,80),second,nativeItem(tail.slice(0,split).trim(),105,90)]]),doc);
  assert.equal(doc.blocks.length,1);
  assert.equal(doc.blocks[0]?.text,prefix+tail);
  assert.equal(doc.blocks[0]?.sources.length,2);
});

test('two original source regions containing the passage prove a repeat despite interleaved PDF items', async () => {
  const tail='The network can be remolded at a sufficiently high temperature while the number of covalent cross-links remains the same at all times.';
  const split=tail.indexOf('while');
  const doc=normalizeContentList([
    {type:'text',text:tail.replace('sufficiently','suficiently'),page_idx:0,bbox:[0,0,470,400]},
    {type:'text',text:'',page_idx:0,bbox:[500,0,1000,400]},
  ],'hash','test',1);
  const first=tail.slice(0,split).trim(),second=tail.slice(split);
  const lowerLeft={...nativeItem(second,10,80),transform:[10,0,0,10,10,70]};
  const lowerRight={...nativeItem(second,105,90),transform:[10,0,0,10,105,70]};
  await auditNativeText(pdfFromItems([[nativeItem(first,10,80),nativeItem(first,105,90),lowerLeft,lowerRight]]),doc);
  assert.equal(doc.blocks.length,2);
  assert.equal(doc.blocks[1]?.text,tail);
});

test('repeated or ambiguous cloud ff spans retain the native fallback', async () => {
  const tail='The network can be remolded at a sufficiently high temperature while the number of covalent cross-links remains the same at all times.';
  const cloud=tail.replace('sufficiently','suficiently');
  for (const paragraphs of [[cloud+' '+cloud],[cloud,tail]]) {
    const doc=normalizeContentList([
      ...paragraphs.map(text=>({type:'text',text,page_idx:0,bbox:[0,0,470,350]})),
      {type:'text',text:'',page_idx:0,bbox:[500,0,1000,350]},
    ],'hash','test',1);
    await auditNativeText(pdfFromItems([[nativeItem('The left column has unrelated native wording.',10,80),nativeItem(tail,105,90)]]),doc);
    assert.equal(doc.blocks.length,paragraphs.length+1);
    assert.equal(doc.blocks.at(-1)?.text,tail);
    assert.equal(doc.blocks[0]?.text,paragraphs[0]);
  }
});

test('non-ligature letter changes and added cloud f letters cannot remove a native fallback', async () => {
  const tail='The network can be remolded at a sufficiently high temperature while the number of covalent cross-links remains the same at all times.';
  for (const cloud of [tail.replace('high','low').replace('sufficiently','suficiently'),tail.replace('sufficiently','suffficiently'),tail.replace(' of ',' off ')]) {
    const doc=normalizeContentList([
      {type:'text',text:cloud,page_idx:0,bbox:[0,0,470,350]},
      {type:'text',text:'',page_idx:0,bbox:[500,0,1000,350]},
    ],'hash','test',1);
    await auditNativeText(pdfFromItems([[nativeItem('The left column has unrelated native wording.',10,80),nativeItem(tail,105,90)]]),doc);
    assert.equal(doc.blocks.length,2);
    assert.equal(doc.blocks[0]?.text,cloud);
    assert.equal(doc.blocks[1]?.text,tail);
  }
});

test('a ligature-tolerant span ending inside cloud math cannot replace that formula', async () => {
  const tail='The network can be remolded at a sufficiently high temperature while the number of covalent cross-links remains the same at all times.';
  const cloud='$'+tail.replace('sufficiently','suficiently')+'^{2}$';
  const doc=normalizeContentList([
    {type:'text',text:cloud,page_idx:0,bbox:[0,0,470,350]},
    {type:'text',text:'',page_idx:0,bbox:[500,0,1000,350]},
  ],'hash','test',1);
  await auditNativeText(pdfFromItems([[nativeItem('The left column has unrelated native wording.',10,80),nativeItem(tail,105,90)]]),doc);
  assert.equal(doc.blocks.length,2);
  assert.equal(doc.blocks[0]?.text,cloud);
  assert.equal(doc.blocks[1]?.text,tail);
});

test('a uniquely matched native fragment corrects a cloud value instead of showing a second paragraph', async () => {
  const sentence = (voltage:number) => `The actuator was tested at ${voltage} V and showed stable performance over repeated actuation cycles with the specified electrode configuration.`;
  const doc=normalizeContentList([
    {type:'text',text:sentence(240),page_idx:0,bbox:[0,0,470,350]},
    {type:'text',text:'',page_idx:0,bbox:[500,0,1000,350]},
  ],'hash','test',1);
  await auditNativeText(pdfFromItems([[nativeItem(sentence(240),10,80),nativeItem(sentence(480),105,90)]]),doc);
  assert.equal(doc.blocks.length,1);
  assert.match(doc.blocks[0]!.text,/480 V/);
  assert.equal(doc.blocks[0]?.sources.length,2);
});

test('mapped evidence corrects a missing subscript while preserving surrounding cloud prose and math', async () => {
  const prefix='Prior result $K = 2$ remains exact. ';
  const sentence='The pentablock (SEHAS) supplies the high strength and low modulus needed for reproducible actuation over many repeated voltage cycles.';
  const suffix=' Following result $M = 7$ also remains exact.';
  const native='The pentablock (SEHAS)₂ supplies the high strength and low modulus needed for reproducible actuation over many repeated voltage cycles.';
  const doc=normalizeContentList([
    {type:'text',text:prefix+sentence+suffix,page_idx:0,bbox:[0,0,470,350]},
    {type:'text',text:'',page_idx:0,bbox:[500,0,1000,350]},
  ],'hash','test',1);
  await auditNativeText(pdfFromItems([[nativeItem('Prior region is retained by the cloud paragraph.',10,80),nativeItem(native,105,90)]]),doc);
  assert.equal(doc.blocks.length,1);
  assert.equal(doc.blocks[0]?.text,prefix+native+suffix);
  assert.equal(doc.blocks[0]?.sources.length,2);
});

test('repeated alphabetic spans are ambiguous and do not remove native evidence', async () => {
  const sentence=(v:number)=>`The actuator was tested at ${v} V and showed stable performance over repeated actuation cycles with the specified electrode configuration.`;
  const doc=normalizeContentList([
    {type:'text',text:sentence(240)+' Another measurement: '+sentence(360),page_idx:0,bbox:[0,0,470,350]},
    {type:'text',text:'',page_idx:0,bbox:[500,0,1000,350]},
  ],'hash','test',1);
  await auditNativeText(pdfFromItems([[nativeItem('The earlier cloud result has two measurements with matching wording.',10,80),nativeItem(sentence(480),105,90)]]),doc);
  assert.equal(doc.blocks.length,2);
  assert.ok(doc.blocks[0]?.text.includes('240 V'));
  assert.ok(doc.blocks[0]?.text.includes('360 V'));
  assert.match(doc.blocks[1]!.text,/480 V/);
});

test('identical distant source prose is not automatically removed', async () => {
  const text='The paragraph repeats a full sentence about dielectric elastomer behavior in a different experimental context with additional source evidence.';
  const doc=normalizeContentList([
    {type:'text',text,page_idx:0,bbox:[0,0,450,250]},
    {type:'text',text:'',page_idx:0,bbox:[650,650,1000,1000]},
  ],'hash','test',1);
  const item={str:text,width:60,height:10,transform:[10,0,0,10,135,20]};
  await auditNativeText(pdfFromItems([[item]]),doc);
  assert.equal(doc.blocks.length,2);
  assert.equal(doc.blocks[1]?.text,text);
});

test('native NFKC and fragment joining verify doubled ff/ffi ligatures in prose and captions', async () => {
  const text='Different films have high conversion efficiency while the loss levels off between measurements and the fabricated samples show reproducible behavior.';
  const cloud='Di<sup>f</sup>erent <sup>fi</sup>lms have high conversion e<sup>fi</sup>ciency while the loss levels o<sup>f</sup> between measurements and the fabricated samples show reproducible behavior.';
  const doc=normalizeContentList([
    {type:'text',text:cloud,page_idx:0,bbox:[0,0,1000,1000]},
    {type:'image',img_path:'fig.jpg',image_caption:['Fig. 1. Di<sup>f</sup>erent films with high e<sup>fi</sup>ciency.'],page_idx:0},
  ],'hash','test',1);
  const words=['Di','ﬀ','erent films have high conversion e','ﬃ','ciency while the loss levels o','ﬀ','between measurements and the fabricated samples show reproducible behavior.'];
  const native=words.map((str,i)=>nativeItem(str,10+i*2,2));
  native.push(nativeItem('Fig. 1. Different films with high efficiency.',10,180));
  await auditNativeText(pdfFromItems([native]),doc);
  assert.ok(!doc.blocks[0]!.text.includes('<sup>f'));
  assert.match(doc.blocks[0]!.text,/Different/);
  assert.match(doc.blocks[0]!.text,/efficiency/);
  assert.match(doc.blocks[0]!.text,/off/);
  assert.equal(doc.blocks[1]?.captions?.[0],'Fig. 1. Different films with high efficiency.');
  assert.equal(text.includes('Different'),true);
});

test('true scientific superscripts and unverified ligature words stay untouched', async () => {
  const original='The coefficient x<sup>f</sup> is independently specified while the original exponent m<sup>3</sup> and <sup>1</sup>H notation remain scientific source content.';
  const doc=normalizeContentList([{type:'text',text:original,page_idx:0,bbox:[0,0,1000,1000]}],'hash','test',1);
  const items=[
    {str:'The coefficient x',width:70,height:14,transform:[14,0,0,14,10,80]},
    {str:'f',width:4,height:8,transform:[8,0,0,8,80,83]},
    {str:' is independently specified while the source contains a longer explanation of the same scientific exponent and its physical meaning.',width:105,height:14,transform:[14,0,0,14,84,80]},
  ];
  await auditNativeText(pdfFromItems([items]),doc);
  assert.equal(doc.blocks[0]?.text,original);
  const unverified=normalizeContentList([{type:'image',img_path:'figure.jpg',image_caption:['Fig. 2. An unverified cla<sup>fi</sup>m remains.'],page_idx:0}],'hash','test',1);
  await auditNativeText(pdfFromItems([[nativeItem('Native evidence describes a different observation and contains enough scientific text for reliable source auditing without the unverified word.')]]),unverified);
  assert.match(unverified.blocks[0]?.captions?.[0]??'',/<sup>fi<\/sup>/);
});

test('multi-page prose is excluded from single-page lexical scoring', async () => {
  const first='The first page describes elasticity modulus tensile mechanics deformation robustness performance structure morphology temperature transition nanoscale composition chemical analysis and characterization of the prepared polymers.';
  const second='The following page presents actuator electrodes voltage applied field reversible cycles bandwidth frequency efficiency energy density pressure displacement hysteresis relaxation stability lifetime durability repeatability conductivity leakage permittivity and dielectric breakdown.';
  const doc={schemaVersion:1 as const,sourceHash:'hash',parserSignature:'test',pageCount:2,warnings:[],blocks:[{
    id:'block-1',kind:'paragraph' as const,text:first+' '+second,sources:[{page:1},{page:2}],
  }]};
  await auditNativeText(pdfFromItems([[nativeItem(first)],[nativeItem(second)]]),doc);
  assert.deepEqual(doc.warnings,[]);
});

test('PDF font fragments do not produce a lexical warning for verified readable cloud prose', async () => {
  const words='The dielectric elastomer maintains large reversible deformation with high mechanical strength and very low modulus while the measured energy density conversion efficiency stability lifetime durability repeatability and conductivity remain consistent across thermal characterization tensile testing and multiple actuation cycles.';
  const original=words+' The permittivity is $\\varepsilon_r$.';
  const native=(words+' The permittivity is εr.').replace(/\s/g,'');
  const doc=normalizeContentList([{type:'text',text:original,page_idx:0,bbox:[0,0,1000,1000]}],'hash','test',1);
  await auditNativeText(pdfFromItems([[nativeItem(native)]]),doc);
  assert.deepEqual(doc.warnings,[]);
  assert.equal(doc.blocks[0]?.text,original);
});

test('geometrically verified subscripts restore both local mentions without altering inline math or cloud wording', async () => {
  const original='(ABCD) combines attractive properties and stable deformation. The coefficient is $\\varepsilon_r$. Importantly, (ABCD) has low modulus and high strength for repeated actuation.';
  const doc=normalizeContentList([{type:'text',text:original,page_idx:0,bbox:[0,0,1000,1000]}],'hash','test',1);
  const items=[
    {str:'(ABCD)',width:40,height:14,transform:[14,0,0,14,10,85]},
    {str:'2',width:4,height:8,transform:[8,0,0,8,50,81]},
    {str:' combines attractive properties and stable deformation. The coefficient is εr.',width:130,height:14,transform:[14,0,0,14,54,85]},
    {str:'Importantly, (ABCD)',width:70,height:14,transform:[14,0,0,14,10,55]},
    {str:'2',width:4,height:8,transform:[8,0,0,8,80,51]},
    {str:' has low modulus and high strength for repeated actuation.',width:100,height:14,transform:[14,0,0,14,84,55]},
  ];
  await auditNativeText(pdfFromItems([items]),doc);
  assert.equal(doc.blocks[0]?.text,original.replaceAll('(ABCD)','(ABCD)<sub>2</sub>'));
  await auditNativeText(pdfFromItems([items]),doc);
  assert.equal(doc.blocks[0]?.text,original.replaceAll('(ABCD)','(ABCD)<sub>2</sub>'));
});

test('source subscripts inside math become LaTeX indices without mixing HTML into the expression', async () => {
  const original='The oxide $ZrO$ improves the measured strength of the dielectric specimen while the expression $K = 7$ stays intact.';
  const doc=normalizeContentList([{type:'text',text:original,page_idx:0,bbox:[0,0,1000,1000]}],'hash','test',1);
  const items=[
    {str:'The oxide ZrO',width:70,height:14,transform:[14,0,0,14,10,80]},
    {str:'2',width:4,height:8,transform:[8,0,0,8,80,76]},
    {str:' improves the measured strength of the dielectric specimen while the expression K = 7 stays intact.',width:100,height:14,transform:[14,0,0,14,84,80]},
  ];
  await auditNativeText(pdfFromItems([items]),doc);
  assert.equal(doc.blocks[0]?.text,original.replace('$ZrO$','$ZrO_{2}$'));
  assert.ok(!doc.blocks[0]?.text.includes('$ZrO<sub>'));
});

test('an existing nested LaTeX subscript is not added a second time', async () => {
  const original='The oxide $\\mathrm{ZrO}_{2}$ improves the measured strength of the dielectric specimen and preserves reliable performance under repeated actuation.';
  const doc=normalizeContentList([{type:'text',text:original,page_idx:0,bbox:[0,0,1000,1000]}],'hash','test',1);
  const items=[
    {str:'The oxide ZrO',width:70,height:14,transform:[14,0,0,14,10,80]},
    {str:'2',width:4,height:8,transform:[8,0,0,8,80,76]},
    {str:' improves the measured strength of the dielectric specimen and preserves reliable performance under repeated actuation.',width:100,height:14,transform:[14,0,0,14,84,80]},
  ];
  await auditNativeText(pdfFromItems([items]),doc);
  assert.equal(doc.blocks[0]?.text,original);
});

test('spaced multi-digit LaTeX indices and conflicting existing indices are preserved', async () => {
  for (const index of ['_ { 2 0 }','_{30}','_ { 2 0 ^ { - } }']) {
    const original='The polymer $\\mathrm{PAA'+index+'}$ improves the measured strength of the dielectric specimen and preserves reliable performance under repeated actuation.';
    const doc=normalizeContentList([{type:'text',text:original,page_idx:0,bbox:[0,0,1000,1000]}],'hash','test',1);
    const items=[
      {str:'The polymer PAA',width:70,height:14,transform:[14,0,0,14,10,80]},
      {str:'20',width:8,height:8,transform:[8,0,0,8,80,76]},
      {str:' improves the measured strength of the dielectric specimen and preserves reliable performance under repeated actuation.',width:96,height:14,transform:[14,0,0,14,88,80]},
    ];
    await auditNativeText(pdfFromItems([items]),doc);
    assert.equal(doc.blocks[0]?.text,original);
  }
});

test('repeated ambiguous baseline wording does not trigger a global subscript replacement', async () => {
  const phrase='(ABCD) has excellent strength and preserves stable behavior under the applied voltage.';
  const original=phrase+' '+phrase+' The native page has a single verified subscript occurrence.';
  const doc=normalizeContentList([{type:'text',text:original,page_idx:0,bbox:[0,0,1000,1000]}],'hash','test',1);
  const items=[
    {str:'(ABCD)',width:40,height:14,transform:[14,0,0,14,10,80]},
    {str:'2',width:4,height:8,transform:[8,0,0,8,50,76]},
    {str:' has excellent strength and preserves stable behavior under the applied voltage.',width:130,height:14,transform:[14,0,0,14,54,80]},
  ];
  await auditNativeText(pdfFromItems([items]),doc);
  assert.equal(doc.blocks[0]?.text,original);
});
