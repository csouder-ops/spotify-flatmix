import 'dotenv/config';
import { resetFlat } from '../lib/store';

const flatCode = process.argv[2] || process.env.FLAT_CODE || 'riasa-apt-12';

resetFlat(flatCode);
console.log(`Cleared data for flat ${flatCode}`);
