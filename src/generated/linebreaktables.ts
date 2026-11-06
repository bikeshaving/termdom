/**
 * Line breaking classes, generated from the Unicode Character Database at
 * 17.0.0. Do not edit; run
 * `node --experimental-strip-types scripts/generate-linebreak-tables.ts`
 * to regenerate. The script describes the packing.
 */

/** The classes a kind names, in the order src/internal/linebreak.ts numbers them. */
export const LINEBREAK_CLASSES = "BK CR LF NL SP ZW ZWJ CM WJ GL CB CL CP EX SY OP QU QU_Pi QU_Pf IS NS B2 BA HH HY BB IN NU PR PO AL HL ID EB EM JL JV JT H2 H3 RI AK AP AS VF VI";

/** A class and its flags: +W East Asian, +P unassigned pictographic. */
export const LINEBREAK_KINDS = "CM BA LF BK CR SP EX QU AL PR PO OP CP IS HY SY NU CL NL GL QU_Pi BB QU_Pf HH HL JL+W JV JT NS AK VI AS ID VF ZW ZWJ B2 IN WJ PR+W ID+W OP+W CL+W AL+W EB EB+W BA+W NS+W CM+W H2+W H3+W EX+W IN+W PO+W CB AP GL+W ID+P RI EM+W AL+P";

/** The kind of each run, as a letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789". */
export const LINEBREAK_RUN_KINDS =
	"ABCDEAFGHIJKIHLMIJNONPQNIGILJMILBRIASATLKJIUIBIKJIVIWILIVIVIVIATAINIAINX" +
	"IJIAXAIAIAGAIYIYIQIKNIAGAGIAQKQIAIGIAQIAIAIAIQIAIAIAIQIAINGIAJIAIAIAIAIA" +
	"IQIAIAQAIAIAIAIABQIAIAIAIAIAIAIAIQIKIKIJIAIAIAIAIAIAIAIQAIAIAIAIAIAIAIAI" +
	"QIJIAIAIAIAIAIAIAIAIQIAIAIAIAIAIQIJIAIAIAIAIAIAIAIQIVIAVIAIAIAIAIAIAIQIA" +
	"IAIAIAIAIAIAIAIQIKIAIAIAIAIAIQIAIAIAIJIAIQBIAIAIAIQIVIVTVBTGTIGIAIQIBAIA" +
	"IALRLRAIABABAIAIAIBIAIVBVITIAIQBIAIAIAIAIAIAIAQAIZabIAIBIXIBILRIBIAIABIA" +
	"IAIABcIBIBJIAIQIGBVIGIATAQIAIAIAIAIGQIQIAIAIAIAQIQIAIATIAdAedIBfBgBgAgBA" +
	"IAIQIfAhIAIBQIQIBIAIAIAIAIAIATATAIVIBTBiAjAXTXkIUWLUWLUIlBDATKIUWIcINLRc" +
	"IBKBIBmIAILRILRIJKJnJKJKJKJKJAIKIKIJIJIlILRLRIoIpqIrIogoIrIgIoIgIgsgIrIg" +
	"IrIgIoIrIrIrIrIogogIgrgIgoIgIgIgIoIgogoIgsoIogrIgtsIrIrIrIrIrIHIGgILRLRL" +
	"RLRLRLRLRIrIrIrILRILRLRLRLRLRIBILRLRLRLRLRLRLRLRLRLRLRILRLRILRIrIrIrIAIG" +
	"BIGBIBIAIAHUWUWHUWHUWBIXLBIUWIUWLRLRLRLRBGIBIBIkBIXBLBIBIBIGLMLMLMLMXIoI" +
	"oIoIouqovopqpqpqpqpqopqpqpqpqvpqowowovogIvovovovovovovovovovovIwvovovovo" +
	"vovovovovovovovovoIoIoIoIovoIoIorovoIoIBIBGBIQIAIAIAIAIBIAIAIAIAIAIKIVGI" +
	"AIAIBQIAIVIAQIABIAIZIAdAegBgIBfIgIAIQIfAIBABAIfIgBIAIAIAIAIAIAIABIAIABAI" +
	"QIxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxy" +
	"xyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxy" +
	"xyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxy" +
	"xyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxy" +
	"xyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxy" +
	"xyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxy" +
	"xyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxy" +
	"xyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxy" +
	"xyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxy" +
	"xyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxy" +
	"xyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxyxy" +
	"xyxyxyxyIaIbIoIYAYIYIYIYIYIYIYIRLIKIAqvzpq0ITATATATATATATAopqpqpqpqpqpqp" +
	"qpqopqoqoqIvzopqpqpqoIon1oImIzon1opqoqoqovozopoqopoqopqpqvovovoIoIoIoIoI" +
	"1nonIrIA2IBIAIAIAIBIBIQIBIBIAIAIAIAIAIBIAIBlIBIAIQIQIAXIAXIBIAIAIAIA3dAe" +
	"BgIgfAdAdITAIAIQBAIQIQIAIAIQBIAIAIVIAIAIBIBAIAQIVIBIABIBIAIAIBIAIQIAIdId" +
	"IdIdIdIdIABAIAIAeIfIAIBfdAIAIAIfIfIfIfdIgAIAIAIAIAe3AgIgIAIAIBIQBIAIAIQI" +
	"AIAVBGIBIAIABIQIVIAIQIQIAIQIBIAIQIdIdIdIdIdAIAIAe3A3ABIfIAIAIVIAIAIAIAVI" +
	"BVIAIAIABIVBIVIAIQIAIAIBIQIVGIAIAIAIAIAIAIAIQIAIAIAIQIQIfBABIA3AdIdAIAeB" +
	"gfAIKIBIBILRIRILRLRILRILTLRTLRLRAIAILRIfAfIQIBIQIABIABIBIQIBQIBIAIAIAIv4" +
	"IwvoIorIroIoIrIrIrIoIvIvIvIvIoIABAIQIAIAIAIAIAIAIAIrIrIQIAIAIAIAIBIAIAIA" +
	"IAIAIAIAIAIAIQIAIAQIJIAQIAIQIAIAIAIAIAIAIQILIKIKIgog5g5g5g5go5g5IrIrI56o" +
	"5o5o5o5o5ogogogotogIgororotototsgogogogo7ogogtotototototototorororotoror" +
	"ogorororIgogogsgtgsgtgogIgIgototIHcIotototogtgogo5ogo5go5IgIgIg5o5o5I8I8" +
	"I8I8I8I8I8I8ItototototogtogototototototoI5g5o5o5oto5o5o5o5ot5IQI5IoIoIAI" +
	"AIAI";

/** The length of each run, base 36. */
export const LINEBREAK_RUN_LENGTHS =
	"9,1,1,2,1,i,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,a,2,3,1,r,1,1,1,t,1,1,1,1,6," +
	"1,q,1,1,1,3,5,1,1,1,2,1,1,2,1,6,1,3,1,eg,1,3,1,i,1,w,2k,7,d,e,1,78,7,73," +
	"1,1,4,1,1,19,1,1,1,2,1,2,1,1,8,r,4,4,d,6,3,3,2,2,b,1,1,3,17,l,a,1,2,3,1," +
	"2r,1,1,7,1,1,6,2,2,1,4,2,a,n,1,u,r,2j,b,f,a,x,9,4,1,1,3,1,2,m,4,1,9,1,3," +
	"1,5,17,3,1g,2,5,9,16,o,1,x,1i,3,1,i,1,7,a,2,2,a,h,3,1k,1,1,7,2,2,2,3,9,1" +
	",a,2,2,a,2,2,5,1,1,1,2,1,2,3,1k,1,1,5,4,2,2,3,3,1,k,a,2,3,1,b,3,1k,1,1,8" +
	",1,3,1,3,k,2,2,a,1,1,8,6,1,3,1k,1,1,7,2,2,2,3,7,3,a,2,2,a,i,1,1n,5,3,3,1" +
	",4,9,1,e,a,9,1,6,5,1j,1,1,7,1,3,1,4,7,2,b,2,2,a,7,1,9,3,1,1j,1,1,7,1,3,1" +
	",4,7,2,b,2,2,a,3,1,c,4,1j,2,1,7,1,3,1,4,9,1,a,2,2,a,9,1,7,3,1y,1,4,6,1,1" +
	",1,8,6,a,2,2,1p,1,2,7,4,1,7,8,1,a,2,2d,1,2,9,b,7,1,a,13,4,1,2,1,2,1,1,5," +
	"1,1,1,3,2,6,a,a,1,1,1,1,1,1,1,1,1,1,2,1d,e,1,5,1,2,5,b,1,10,1,2,6,1,9,2," +
	"1,1,5,2,28,k,1,a,2,a,4,4,3,1,3,2,7,3,4,d,c,1,1,a,4,2q,2o,20,2g,9p,3,1,1," +
	"4e,1,hr,1,q,1,1,26,3,10,4,s,3,2,r,2,u,2,1s,w,2,1,1,1,1,1,1,1,1,2,a,o,2,2" +
	",1,1,2,1,3,1,1,a,2z,2,y,1,3a,c,4,c,8,2,a,3k,b,1o,5,1l,a,1,t,2,1,a,6,a,m," +
	"1a,2,b,1,k,5,1b,g,1,8,1,2,a,2,1,4,a,9,9,3,3,u,d,2,a,6,12,c,2,1c,k,3,5,a," +
	"6,a,10,2,28,3,1,l,4,1,6,1,2,3,5i,d,1,1a,1,3,e5,1,2,7,1,3,1,1,1,2,1,1,2,1" +
	",3,1,1,1,2,1,1,1,4,3,1,2,5,1,8,1,1,1,1,2,6,1,1,1,3,c,1,1,4,1,3,1,5,a,d,1" +
	",1,e,1,1,h,7,1,1,1,c,1,4,1,2,1,1,1,f,x,i,1,5,1,c,1,6z,2,63,1,o,1,1,1,1,e" +
	",2,d,1,1,5a,4,3,1,2,1,eh,2,1,4,g,2,2,1,1,3,1,2,g,8,1,3,c,c,k,1,m,1,a,6,3" +
	",1,d,1,8,2,h,2,5,2,3,4,1,1,3,1,1,1,3,2,2,1,2,3,8,1,6,1,2,1,1,1,2,1,1,2,1" +
	",7,1,2,2,2,2,q,1,z,1,1,1,4,3,1,1,3,6,1,2,1,3,1,1,1,1,1,1,1,1,1,1,1,1,1,1" +
	",v,3,o,1,e,1,5,1,1,v,1,1,1,1,1,1,1,1,1,1,g,1,aq,1,1,1,1,1,1,1,1,1,1,1,1," +
	"1,1,1,1,1,1,1,1,1,1,1r,1,1,1,1,w,1,1,7x,2,1f,1,4,1,bd,3,7,1,3,1,1,1,34,1" +
	",e,1,2o,w,2,1,1,1,1,3,1,1,1,1,1,8,1,1,1,1,2,1,1,2,1,1,1,1,1,1,1,1,1,1,4," +
	"1,1,2,1,2,5,2,3,1,1,1,1,8,1,1,1,2,3,2,1,1,1,1,1,1,1,1,1,y,q,1,2h,c,5y,q," +
	"g,1,2,2,1,2,1,1,1,1,1,1,1,1,1,1,2,1,1,1,1,1,1,1,1,1,1,2,a,6,5,1,5,2,2,1," +
	"1,1,1,1,1,1,1,1,1,1,p,1,v,1,1,1,1,1,6,1,6,2,2,2,4,1,2,1,1,1,1,1,1,1,1,p," +
	"1,v,1,1,1,1,1,6,1,6,2,4,4,1,5,17,1,2m,1,2e,9,1,g,v,1,14,8,5f4,1s,g7p,1,v" +
	"r,3,1j,1j,2,7h,1,1,1,g,a,1x,4,1,a,w,2,28,2,1,5,7e,1,3,1,4,1,n,5,4,1,b,1," +
	"1n,2,2,8,2,1e,i,8,2,a,6,i,a,1,2,1,a,s,8,2,n,d,c,t,3,4,1b,d,1,6,3,4,1,1,a" +
	",4,2,5,1,a,a,6,15,e,9,3,1,8,2,2,a,2,1,3,r,3,1e,1,1,3,2,2,5,2,1,1,15,5,2," +
	"3,2,6k,8,1,2,2,a,6,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,1" +
	",r,1,r,1,r,1,r,1,r,1,r,1,r,1,r,c,n,4,1d,6is,e8,t,1,1,a,1,d,1,5,1,1,1,2,1" +
	",2,1,a,dq,1,1,58,1,3,g,3,2,2,1,1,1,6,1,1,1,1,1,1,2,1,1,1,1,1,2,1,5,1,1,1" +
	",1,1,1,1,1,1,1,1,1,1,1,1,1,2,1,1,7,1,1,1,1,2,2,1,1,1,1,1,1,1,8,1,1,1,1,1" +
	",43,1,1,1,2,1,1,2,1,1,2,1,1,1,b,2,3,1,r,1,1,1,t,1,1,1,1,1,2,1,2,1,1,a,19" +
	",2,v,3,6,2,6,2,6,2,3,3,1,1,3,2,1,7,a,3,1,77,3,6y,1,6a,1,45,5,10,1,1c,1,5" +
	"r,a,q5,1,5j,1,69,3,1,2,5,4,14,3,4,1,g,8,3x,2,9,6,1,1u,7,dg,4,8,a,6,a,v,5" +
	",1,8s,2,1,y,1,15,6,1y,b,1d,4,3e,3,2,1f,e,1,2,5,4,k,a,1,2,2,1,9,1,3,19,b," +
	"2,1,4,1,a,1,y,a,6,3,10,e,1,a,4,1,2,18,1,1,1,a,3,1c,e,4,2,1,1,4,1,2,a,1,1" +
	",1,3,24,c,2,1,2,1,1,2,1,2v,1,1h,c,5,a,6,4,1,8,2,2,2,m,1,7,1,2,1,5,1,2,1," +
	"7,2,2,2,2,1,2,1,6,1,5,1,2,2,2,2,7,3,5,b,a,1,1,2,1,1,2,10,1,1,9,1,1,2,1,1" +
	",4,1,4,1,1,1,3,1,2,8,2,2a,i,4,4,1,a,2,2,1,29,k,c,a,5x,7,2,9,1,2,2,3,f,4," +
	"2,2a,h,2,d,a,6,d,1q,d,8,a,6,k,1l,f,4,a,2,3,6l,f,4l,a,m,7,2,1,2,8,1,2,1,o" +
	",6,1,2,2,3,1,1,1,1,2,3,9,a,3b,7,2,7,1,1,1,1,s,a,14,7,1,4,1,1,4,1,1,1,9,b" +
	",1a,g,3,1,3,2,2l,a,2e,8,3s,a,1h,8,1,8,1,5,a,a,m,1,1,w,m,1,e,3e,6,3,1,1,2" +
	",1,7,1,1,8,a,1c,5,1,2,1,5,8,a,1i,a,6u,i,1,4,2,7,2,1,1,d,1,y,7,3,4,1,2,b," +
	"a,1,3m,4,u,1,vk,5,2qr,3,3,10,1,3,1,1,1,1,6n,1,2,4z,1,7,1,1,3,1,1,1,1,1,6" +
	",f,3g8,1,1,5dc,u,i,a,1t2,a,4,2,28,a,12,5,1,1m,7,3,a,1,b,a,es,2,a,7x,2,52" +
	",1,1,1j,7,4,25,4,1,b,2,2,3,9,5c0,d2,15,1,v,2p,37,6pp,4,1,7,1,2,1,83,f,1," +
	"t,3,2,1,e,4,8,b0,1wh,2,1,4,37w,a,ee,1a,2,n,f2,5,3,m,2,7,u,4,44,3,57,2f,9" +
	",n,uv,1e,e8,1j,4,1e,8,1,e,1,2,4,g,5,1,f,11s,7,1,h,2,7,1,2,1,5,2s,1,4g,7," +
	"9,a,9w,1,1p,4,a,5,1,do,4,a,6s,2,1,a,6g,1,2,1,7,2,5,1,d6,7,31,7,5,a,4,2,n" +
	"g,1,3,1,nj,4,1,13,4,2s,c,f,2,f,1,e,1,1,11,a,3y,1,2,a,j,1k,q,3,d,18,4,9,7" +
	",2,e,6,4a,x,c,9,1,1y,1,7,1,e,8,2,2,l,2,5,1,5,3,2,1,2,1,2,2,5,c,h,3,1,3,3" +
	",5,1r,1,1,1,2,2,b,l,j,3,1,4,3,1,3,7,1,1,1,e,1,1,1,1,1,5,1,4,1,1,2,22,2,1" +
	",7,g,e,d,c,c,1,4,1,o,c,2,4,1,l,1,4,2,d,1,1b,8,o,6,1,22,3,3,5,12,3,3,4,z," +
	"1,g,3,9,1,5,6,1,3,3,2,4,3,4,b,2,3,4,9,3,38,3,4,5,2d,5,6,c,4,1,f,c,4,1k,8" +
	",a,6,14,8,u,2,c,4,2,e,9,13,c,1,2,1,8,8,6,1,9,a,1,1,3,7,1,1c,1,1p,2,1,2,1" +
	",1,h,3,1,d,y,2g,8,e,2,d,3,b,3,1h,3,1,1,1,4,g,2,c,4,1,9,7,6o,a,6,se,2,1ek" +
	"e,2,1eke,e1oj,1,u,2o,3k,6o,47bk";
