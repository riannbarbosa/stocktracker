import pg from 'pg';
import { config } from '../config.ts';  

const { Pool, types } = pg;

// Override the default parser for numeric types to return strings instead of numbers
types.setTypeParser(types.builtins.NUMERIC, (value: string) => value);

export const pool = new Pool({
    connectionString: config.db.connectionString,
    max: config.db.maxPoolSize,
    idleTimeoutMillis: config.db.idleTimeoutMillis,
    connectionTimeoutMillis: config.db.connectionTimeoutMillis,
});


pool.on('error', (err: Error) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

export async function pingDatabase(): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('SELECT 1');
    } finally {
        client.release();
    }
}

export async function closePool(): Promise<void> {
    await pool.end();
}