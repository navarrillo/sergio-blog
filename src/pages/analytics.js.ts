import type { APIRoute } from 'astro';
export const GET: APIRoute = () =>
  new Response(
    `if(!navigator.webdriver&&!location.pathname.startsWith('/admin')&&new URLSearchParams(location.search).get('tracking')!=='off'){const s=document.createElement('script');s.src='https://analytics.sergionavarro.me/script.js';s.defer=true;s.dataset.websiteId=document.currentScript.dataset.websiteId;document.head.appendChild(s);}`,
    {
      headers: {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'public,max-age=3600',
      },
    },
  );
