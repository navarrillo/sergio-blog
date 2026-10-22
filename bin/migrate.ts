import { migrate } from '../src/lib/db';
await migrate();
console.log('Database migrations complete.');
