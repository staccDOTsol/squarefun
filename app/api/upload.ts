import type {VercelRequest, VercelResponse} from '@vercel/node';
import {handleUpload, type HandleUploadBody} from '@vercel/blob/client';

/**
 * Issues short-lived client-upload tokens for launch images. The browser
 * uploads straight to Vercel Blob; only the resulting public URL goes on-chain.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({error: 'POST only'});
    return;
  }
  try {
    const body = req.body as HandleUploadBody;
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async pathname => {
        if (!/^launch\/[a-z0-9-]+\.(png|jpe?g|webp|gif|svg)$/i.test(pathname)) throw new Error('bad path');
        return {
          allowedContentTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'],
          maximumSizeInBytes: 4 * 1024 * 1024,
          addRandomSuffix: true,
          cacheControlMaxAge: 60 * 60 * 24 * 365,
        };
      },
      onUploadCompleted: async () => {},
    });
    res.status(200).json(result);
  } catch (e) {
    res.status(400).json({error: e instanceof Error ? e.message : 'upload failed'});
  }
}
