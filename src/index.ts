export type Header={name:string;value:string};
export function parseHeaders(input:string):Header[]{const out:Record<string,string>={};for(const line of input.split(/\r?\n/)){const at=line.indexOf(':');if(at>0)out[line.slice(0,at).toLowerCase()]=line.slice(at+1).trim()}return Object.entries(out).map(([name,value])=>({name,value}))}
export class MimeStream{#buffer='';feed(chunk:string){this.#buffer+=chunk;const at=this.#buffer.indexOf('\r\n\r\n');if(at<0)return [];const head=this.#buffer.slice(0,at);this.#buffer=this.#buffer.slice(at+4);return [{headers:parseHeaders(head),body:this.#buffer}]}}
