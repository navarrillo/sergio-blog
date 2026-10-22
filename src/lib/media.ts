import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { config } from './config';
export async function storeImage(bytes:Uint8Array){if(bytes.byteLength>config.maxImage||bytes.byteLength===0)throw new Error('Image must be between 1 byte and 8 MB');const decoder=sharp(bytes,{limitInputPixels:40000000,animated:false});const metadata=await decoder.metadata();if(!['jpeg','png','webp'].includes(metadata.format||''))throw new Error('Only JPEG, PNG and WebP images are supported');const output=await decoder.rotate().resize({width:2000,height:2000,fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer();const filename=randomUUID()+'.webp';await mkdir(config.uploads,{recursive:true,mode:0o700});await writeFile(`${config.uploads}/${filename}`,output,{mode:0o600});return '/uploads/'+filename;}
