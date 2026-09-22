import { readFile } from 'node:fs/promises';
import { join } from 'node:path'
import { pool, pingDatabase } from './pool.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.ts'

async function waitForDatabaseConnection(log: (msg: string) => void): Promise<void> {
    const { startupRetries, startupRetryDelayMs } = config.postgres; 
    for (let attempt = 1; attempt <= startupRetries; attempt++) {
        try {
            await pingDatabase();
            log('Database connection successful.');
            return;
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if(attempt === startupRetries) {
                throw new Error(`Postgres unreachable after ${startupRetries} attempts: ${reason}`, { cause: error });
            }
            log(`Postgres not ready (attempt ${attempt}/${startupRetries}): ${reason}`);
            await sleep(startupRetryDelayMs);
        }
    }
}
          
export async function migrateDatabase(log: (message: string) => void = console.log): Promise<void> {
    await waitForDatabaseConnection(log);
    const schemaPath = join(import.meta.dirname, 'schema.sql');
    const schemaSql = await readFile(schemaPath, 'utf-8');
    const client = await pool.connect();
    try{
        await client.query('BEGIN');
        await client.query(schemaSql);
        await client.query('COMMIT');
        log('Database migration completed successfully.');
    }
    catch (error) {
        await client.query('ROLLBACK');
        log(`Database migration failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
    finally {
        client.release();
    }
}
    