import 'dotenv/config';

import type { TestFn } from 'ava';
import anyTest from 'ava';
import Docker from 'dockerode';
import {
	and,
	asc,
	DrizzleError,
	eq,
	gt,
	gte,
	inArray,
	lt,
	Name,
	name,
	placeholder,
	type SQL,
	sql,
	type SQLWrapper,
} from 'drizzle-orm';
import {
	alias,
	type AnyPgColumn,
	boolean,
	getMaterializedViewConfig,
	getViewConfig,
	integer,
	jsonb,
	pgEnum,
	pgMaterializedView,
	pgTable,
	pgTableCreator,
	pgView,
	serial,
	text,
	timestamp,
	uuid as pgUuid,
	varchar,
} from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import getPort from 'get-port';
import postgres, { type Sql } from 'postgres';
import { v4 as uuid } from 'uuid';
import { type Equal, Expect } from './utils';

const QUERY_LOGGING = false;

const usersTable = pgTable('users', {
	id: serial('id').primaryKey(),
	name: text('name').notNull(),
	verified: boolean('verified').notNull().default(false),
	jsonb: jsonb('jsonb').$type<string[]>(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

const users2Table = pgTable('users2', {
	id: serial('id').primaryKey(),
	name: text('name').notNull(),
	cityId: integer('city_id').references(() => citiesTable.id),
});

const citiesTable = pgTable('cities', {
	id: serial('id').primaryKey(),
	name: text('name').notNull(),
});

const coursesTable = pgTable('courses', {
	id: serial('id').primaryKey(),
	name: text('name').notNull(),
	categoryId: integer('category_id').references(() => courseCategoriesTable.id),
});

const courseCategoriesTable = pgTable('course_categories', {
	id: serial('id').primaryKey(),
	name: text('name').notNull(),
});

const orders = pgTable('orders', {
	id: serial('id').primaryKey(),
	region: text('region').notNull(),
	product: text('product').notNull(),
	amount: integer('amount').notNull(),
	quantity: integer('quantity').notNull(),
});

const usersMigratorTable = pgTable('users12', {
	id: serial('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull(),
});

interface Context {
	docker: Docker;
	pgContainer: Docker.Container;
	db: PostgresJsDatabase;
	client: Sql;
}

const test = anyTest as TestFn<Context>;

async function createDockerDB(ctx: Context): Promise<string> {
	const docker = (ctx.docker = new Docker());
	const port = await getPort({ port: 5432 });
	const image = 'postgres:14';

	const pullStream = await docker.pull(image);
	await new Promise((resolve, reject) =>
		docker.modem.followProgress(pullStream, (err) => (err ? reject(err) : resolve(err)))
	);

	const pgContainer = (ctx.pgContainer = await docker.createContainer({
		Image: image,
		Env: ['POSTGRES_PASSWORD=postgres', 'POSTGRES_USER=postgres', 'POSTGRES_DB=postgres'],
		name: `drizzle-integration-tests-${uuid()}`,
		HostConfig: {
			AutoRemove: true,
			PortBindings: {
				'5432/tcp': [{ HostPort: `${port}` }],
			},
		},
	}));

	await pgContainer.start();

	return `postgres://postgres:postgres@localhost:${port}/postgres`;
}

test.before(async (t) => {
	const ctx = t.context;
	const connectionString = process.env['PG_CONNECTION_STRING'] ?? await createDockerDB(ctx);

	const sleep = 250;
	let timeLeft = 5000;
	let connected = false;
	let lastError: unknown | undefined;
	do {
		try {
			ctx.client = postgres(connectionString, {
				max: 1,
				onnotice: () => {
					// disable notices
				},
			});
			await ctx.client`select 1`;
			connected = true;
			break;
		} catch (e) {
			lastError = e;
			await new Promise((resolve) => setTimeout(resolve, sleep));
			timeLeft -= sleep;
		}
	} while (timeLeft > 0);
	if (!connected) {
		console.error('Cannot connect to Postgres');
		throw lastError;
	}
	ctx.db = drizzle(ctx.client, { logger: QUERY_LOGGING });
});

test.after.always(async (t) => {
	const ctx = t.context;
	await ctx.client?.end().catch(console.error);
	await ctx.pgContainer?.stop().catch(console.error);
});

test.beforeEach(async (t) => {
	const ctx = t.context;
	await ctx.db.execute(sql`drop schema public cascade`);
	await ctx.db.execute(sql`create schema public`);
	await ctx.db.execute(
		sql`
			create table users (
				id serial primary key,
				name text not null,
				verified boolean not null default false, 
				jsonb jsonb,
				created_at timestamptz not null default now()
			)
		`,
	);
	await ctx.db.execute(
		sql`
			create table cities (
				id serial primary key,
				name text not null
			)
		`,
	);
	await ctx.db.execute(
		sql`
			create table users2 (
				id serial primary key,
				name text not null,
				city_id integer references cities(id)
			)
		`,
	);
	await ctx.db.execute(
		sql`
			create table course_categories (
				id serial primary key,
				name text not null
			)
		`,
	);
	await ctx.db.execute(
		sql`
			create table courses (
				id serial primary key,
				name text not null,
				category_id integer references course_categories(id)
			)
		`,
	);
	await ctx.db.execute(
		sql`
			create table orders (
				id serial primary key,
				region text not null,
				product text not null,
				amount integer not null,
				quantity integer not null
			)
		`,
	);
});

test.serial('select all fields', async (t) => {
	const { db } = t.context;

	const now = Date.now();

	await db.insert(usersTable).values({ name: 'John' });
	const result = await db.select().from(usersTable);

	t.assert(result[0]!.createdAt instanceof Date); // eslint-disable-line no-instanceof/no-instanceof
	t.assert(Math.abs(result[0]!.createdAt.getTime() - now) < 100);
	t.deepEqual(result, [{ id: 1, name: 'John', verified: false, jsonb: null, createdAt: result[0]!.createdAt }]);
});

test.serial('select sql', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values({ name: 'John' });
	const users = await db.select({
		name: sql`upper(${usersTable.name})`,
	}).from(usersTable);

	t.deepEqual(users, [{ name: 'JOHN' }]);
});

test.serial('select typed sql', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values({ name: 'John' });
	const users = await db.select({
		name: sql<string>`upper(${usersTable.name})`,
	}).from(usersTable);

	t.deepEqual(users, [{ name: 'JOHN' }]);
});

test.serial('select distinct', async (t) => {
	const { db } = t.context;

	const usersDistinctTable = pgTable('users_distinct', {
		id: integer('id').notNull(),
		name: text('name').notNull(),
	});

	await db.execute(sql`drop table if exists ${usersDistinctTable}`);
	await db.execute(sql`create table ${usersDistinctTable} (id integer, name text)`);

	await db.insert(usersDistinctTable).values([
		{ id: 1, name: 'John' },
		{ id: 1, name: 'John' },
		{ id: 2, name: 'John' },
		{ id: 1, name: 'Jane' },
	]);
	const users1 = await db.selectDistinct().from(usersDistinctTable).orderBy(
		usersDistinctTable.id,
		usersDistinctTable.name,
	);
	const users2 = await db.selectDistinctOn([usersDistinctTable.id]).from(usersDistinctTable).orderBy(
		usersDistinctTable.id,
	);
	const users3 = await db.selectDistinctOn([usersDistinctTable.name], { name: usersDistinctTable.name }).from(
		usersDistinctTable,
	).orderBy(usersDistinctTable.name);

	await db.execute(sql`drop table ${usersDistinctTable}`);

	t.deepEqual(users1, [{ id: 1, name: 'Jane' }, { id: 1, name: 'John' }, { id: 2, name: 'John' }]);

	t.deepEqual(users2.length, 2);
	t.deepEqual(users2[0]?.id, 1);
	t.deepEqual(users2[1]?.id, 2);

	t.deepEqual(users3.length, 2);
	t.deepEqual(users3[0]?.name, 'Jane');
	t.deepEqual(users3[1]?.name, 'John');
});

test.serial('insert returning sql', async (t) => {
	const { db } = t.context;

	const users = await db.insert(usersTable).values({ name: 'John' }).returning({
		name: sql`upper(${usersTable.name})`,
	});

	t.deepEqual(users, [{ name: 'JOHN' }]);
});

test.serial('delete returning sql', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values({ name: 'John' });
	const users = await db.delete(usersTable).where(eq(usersTable.name, 'John')).returning({
		name: sql`upper(${usersTable.name})`,
	});

	t.deepEqual(users, [{ name: 'JOHN' }]);
});

test.serial('update returning sql', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values({ name: 'John' });
	const users = await db.update(usersTable).set({ name: 'Jane' }).where(eq(usersTable.name, 'John')).returning({
		name: sql`upper(${usersTable.name})`,
	});

	t.deepEqual(users, [{ name: 'JANE' }]);
});

test.serial('update with returning all fields', async (t) => {
	const { db } = t.context;

	const now = Date.now();

	await db.insert(usersTable).values({ name: 'John' });
	const users = await db.update(usersTable).set({ name: 'Jane' }).where(eq(usersTable.name, 'John')).returning();

	t.assert(users[0]!.createdAt instanceof Date); // eslint-disable-line no-instanceof/no-instanceof
	t.assert(Math.abs(users[0]!.createdAt.getTime() - now) < 100);
	t.deepEqual(users, [{ id: 1, name: 'Jane', verified: false, jsonb: null, createdAt: users[0]!.createdAt }]);
});

test.serial('update with returning partial', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values({ name: 'John' });
	const users = await db.update(usersTable).set({ name: 'Jane' }).where(eq(usersTable.name, 'John')).returning({
		id: usersTable.id,
		name: usersTable.name,
	});

	t.deepEqual(users, [{ id: 1, name: 'Jane' }]);
});

test.serial('delete with returning all fields', async (t) => {
	const { db } = t.context;

	const now = Date.now();

	await db.insert(usersTable).values({ name: 'John' });
	const users = await db.delete(usersTable).where(eq(usersTable.name, 'John')).returning();

	t.assert(users[0]!.createdAt instanceof Date); // eslint-disable-line no-instanceof/no-instanceof
	t.assert(Math.abs(users[0]!.createdAt.getTime() - now) < 100);
	t.deepEqual(users, [{ id: 1, name: 'John', verified: false, jsonb: null, createdAt: users[0]!.createdAt }]);
});

test.serial('delete with returning partial', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values({ name: 'John' });
	const users = await db.delete(usersTable).where(eq(usersTable.name, 'John')).returning({
		id: usersTable.id,
		name: usersTable.name,
	});

	t.deepEqual(users, [{ id: 1, name: 'John' }]);
});

test.serial('insert + select', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values({ name: 'John' });
	const result = await db.select().from(usersTable);
	t.deepEqual(result, [{ id: 1, name: 'John', verified: false, jsonb: null, createdAt: result[0]!.createdAt }]);

	await db.insert(usersTable).values({ name: 'Jane' });
	const result2 = await db.select().from(usersTable);
	t.deepEqual(result2, [
		{ id: 1, name: 'John', verified: false, jsonb: null, createdAt: result2[0]!.createdAt },
		{ id: 2, name: 'Jane', verified: false, jsonb: null, createdAt: result2[1]!.createdAt },
	]);
});

test.serial('json insert', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values({ name: 'John', jsonb: ['foo', 'bar'] });
	const result = await db.select({
		id: usersTable.id,
		name: usersTable.name,
		jsonb: usersTable.jsonb,
	}).from(usersTable);

	t.deepEqual(result, [{ id: 1, name: 'John', jsonb: ['foo', 'bar'] }]);
});

test.serial('insert with overridden default values', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values({ name: 'John', verified: true });
	const result = await db.select().from(usersTable);

	t.deepEqual(result, [{ id: 1, name: 'John', verified: true, jsonb: null, createdAt: result[0]!.createdAt }]);
});

test.serial('insert many', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values([
		{ name: 'John' },
		{ name: 'Bruce', jsonb: ['foo', 'bar'] },
		{ name: 'Jane' },
		{ name: 'Austin', verified: true },
	]);
	const result = await db.select({
		id: usersTable.id,
		name: usersTable.name,
		jsonb: usersTable.jsonb,
		verified: usersTable.verified,
	}).from(usersTable);

	t.deepEqual(result, [
		{ id: 1, name: 'John', jsonb: null, verified: false },
		{ id: 2, name: 'Bruce', jsonb: ['foo', 'bar'], verified: false },
		{ id: 3, name: 'Jane', jsonb: null, verified: false },
		{ id: 4, name: 'Austin', jsonb: null, verified: true },
	]);
});

test.serial('insert many with returning', async (t) => {
	const { db } = t.context;

	const result = await db.insert(usersTable).values([
		{ name: 'John' },
		{ name: 'Bruce', jsonb: ['foo', 'bar'] },
		{ name: 'Jane' },
		{ name: 'Austin', verified: true },
	])
		.returning({
			id: usersTable.id,
			name: usersTable.name,
			jsonb: usersTable.jsonb,
			verified: usersTable.verified,
		});

	t.deepEqual(result, [
		{ id: 1, name: 'John', jsonb: null, verified: false },
		{ id: 2, name: 'Bruce', jsonb: ['foo', 'bar'], verified: false },
		{ id: 3, name: 'Jane', jsonb: null, verified: false },
		{ id: 4, name: 'Austin', jsonb: null, verified: true },
	]);
});

test.serial('select with group by as field', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values([{ name: 'John' }, { name: 'Jane' }, { name: 'Jane' }]);

	const result = await db.select({ name: usersTable.name }).from(usersTable)
		.groupBy(usersTable.name);

	t.deepEqual(result, [{ name: 'Jane' }, { name: 'John' }]);
});

test.serial('select with group by as sql', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values([{ name: 'John' }, { name: 'Jane' }, { name: 'Jane' }]);

	const result = await db.select({ name: usersTable.name }).from(usersTable)
		.groupBy(sql`${usersTable.name}`);

	t.deepEqual(result, [{ name: 'Jane' }, { name: 'John' }]);
});

test.serial('select with group by as sql + column', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values([{ name: 'John' }, { name: 'Jane' }, { name: 'Jane' }]);

	const result = await db.select({ name: usersTable.name }).from(usersTable)
		.groupBy(sql`${usersTable.name}`, usersTable.id);

	t.deepEqual(result, [{ name: 'Jane' }, { name: 'Jane' }, { name: 'John' }]);
});

test.serial('select with group by as column + sql', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values([{ name: 'John' }, { name: 'Jane' }, { name: 'Jane' }]);

	const result = await db.select({ name: usersTable.name }).from(usersTable)
		.groupBy(usersTable.id, sql`${usersTable.name}`);

	t.deepEqual(result, [{ name: 'Jane' }, { name: 'Jane' }, { name: 'John' }]);
});

test.serial('select with group by complex query', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values([{ name: 'John' }, { name: 'Jane' }, { name: 'Jane' }]);

	const result = await db.select({ name: usersTable.name }).from(usersTable)
		.groupBy(usersTable.id, sql`${usersTable.name}`)
		.orderBy(asc(usersTable.name))
		.limit(1);

	t.deepEqual(result, [{ name: 'Jane' }]);
});

test.serial('build query', async (t) => {
	const { db } = t.context;

	const query = db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable)
		.groupBy(usersTable.id, usersTable.name)
		.toSQL();

	t.deepEqual(query, {
		sql: 'select "id", "name" from "users" group by "users"."id", "users"."name"',
		params: [],
	});
});

test.serial('insert sql', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values({ name: sql`${'John'}` });
	const result = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable);
	t.deepEqual(result, [{ id: 1, name: 'John' }]);
});

test.serial('partial join with alias', async (t) => {
	const { db } = t.context;
	const customerAlias = alias(usersTable, 'customer');

	await db.insert(usersTable).values([{ id: 10, name: 'Ivan' }, { id: 11, name: 'Hans' }]);
	const result = await db
		.select({
			user: {
				id: usersTable.id,
				name: usersTable.name,
			},
			customer: {
				id: customerAlias.id,
				name: customerAlias.name,
			},
		}).from(usersTable)
		.leftJoin(customerAlias, eq(customerAlias.id, 11))
		.where(eq(usersTable.id, 10));

	t.deepEqual(result, [{
		user: { id: 10, name: 'Ivan' },
		customer: { id: 11, name: 'Hans' },
	}]);
});

test.serial('full join with alias', async (t) => {
	const { db } = t.context;

	const pgTable = pgTableCreator((name) => `prefixed_${name}`);

	const users = pgTable('users', {
		id: serial('id').primaryKey(),
		name: text('name').notNull(),
	});

	await db.execute(sql`drop table if exists ${users}`);
	await db.execute(sql`create table ${users} (id serial primary key, name text not null)`);

	const customers = alias(users, 'customer');

	await db.insert(users).values([{ id: 10, name: 'Ivan' }, { id: 11, name: 'Hans' }]);
	const result = await db
		.select().from(users)
		.leftJoin(customers, eq(customers.id, 11))
		.where(eq(users.id, 10));

	t.deepEqual(result, [{
		users: {
			id: 10,
			name: 'Ivan',
		},
		customer: {
			id: 11,
			name: 'Hans',
		},
	}]);

	await db.execute(sql`drop table ${users}`);
});

test.serial('select from alias', async (t) => {
	const { db } = t.context;

	const pgTable = pgTableCreator((name) => `prefixed_${name}`);

	const users = pgTable('users', {
		id: serial('id').primaryKey(),
		name: text('name').notNull(),
	});

	await db.execute(sql`drop table if exists ${users}`);
	await db.execute(sql`create table ${users} (id serial primary key, name text not null)`);

	const user = alias(users, 'user');
	const customers = alias(users, 'customer');

	await db.insert(users).values([{ id: 10, name: 'Ivan' }, { id: 11, name: 'Hans' }]);
	const result = await db
		.select()
		.from(user)
		.leftJoin(customers, eq(customers.id, 11))
		.where(eq(user.id, 10));

	t.deepEqual(result, [{
		user: {
			id: 10,
			name: 'Ivan',
		},
		customer: {
			id: 11,
			name: 'Hans',
		},
	}]);

	await db.execute(sql`drop table ${users}`);
});

test.serial('insert with spaces', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values({ name: sql`'Jo   h     n'` });
	const result = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable);

	t.deepEqual(result, [{ id: 1, name: 'Jo   h     n' }]);
});

test.serial('prepared statement', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values({ name: 'John' });
	const statement = db.select({
		id: usersTable.id,
		name: usersTable.name,
	}).from(usersTable)
		.prepare('statement1');
	const result = await statement.execute();

	t.deepEqual(result, [{ id: 1, name: 'John' }]);
});

test.serial('prepared statement with placeholder in .limit', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values({ name: 'John' });
	const stmt = db
		.select({
			id: usersTable.id,
			name: usersTable.name,
		})
		.from(usersTable)
		.where(eq(usersTable.id, placeholder('id')))
		.limit(placeholder('limit'))
		.prepare('stmt_limit');

	const result = await stmt.execute({ id: 1, limit: 1 });

	t.deepEqual(result, [{ id: 1, name: 'John' }]);
	t.is(result.length, 1);
});

test.serial('prepared statement with placeholder in .offset', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values([{ name: 'John' }, { name: 'John1' }]);
	const stmt = db
		.select({
			id: usersTable.id,
			name: usersTable.name,
		})
		.from(usersTable)
		.offset(placeholder('offset'))
		.prepare('stmt_offset');

	const result = await stmt.execute({ offset: 1 });

	t.deepEqual(result, [{ id: 2, name: 'John1' }]);
});

test.serial('prepared statement reuse', async (t) => {
	const { db } = t.context;

	const stmt = db.insert(usersTable).values({
		verified: true,
		name: placeholder('name'),
	}).prepare('stmt2');

	for (let i = 0; i < 10; i++) {
		await stmt.execute({ name: `John ${i}` });
	}

	const result = await db.select({
		id: usersTable.id,
		name: usersTable.name,
		verified: usersTable.verified,
	}).from(usersTable);

	t.deepEqual(result, [
		{ id: 1, name: 'John 0', verified: true },
		{ id: 2, name: 'John 1', verified: true },
		{ id: 3, name: 'John 2', verified: true },
		{ id: 4, name: 'John 3', verified: true },
		{ id: 5, name: 'John 4', verified: true },
		{ id: 6, name: 'John 5', verified: true },
		{ id: 7, name: 'John 6', verified: true },
		{ id: 8, name: 'John 7', verified: true },
		{ id: 9, name: 'John 8', verified: true },
		{ id: 10, name: 'John 9', verified: true },
	]);
});

test.serial('prepared statement with placeholder in .where', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values({ name: 'John' });
	const stmt = db.select({
		id: usersTable.id,
		name: usersTable.name,
	}).from(usersTable)
		.where(eq(usersTable.id, placeholder('id')))
		.prepare('stmt3');
	const result = await stmt.execute({ id: 1 });

	t.deepEqual(result, [{ id: 1, name: 'John' }]);
});

// TODO change tests to new structure
test.serial('migrator', async (t) => {
	const { db } = t.context;

	await db.execute(sql`drop table if exists ${usersMigratorTable}`);
	await db.execute(sql`drop table if exists "drizzle"."__drizzle_migrations"`);

	await migrate(db, { migrationsFolder: './drizzle2/pg' });

	await db.insert(usersMigratorTable).values({ name: 'John', email: 'email' });

	const result = await db.select().from(usersMigratorTable);

	t.deepEqual(result, [{ id: 1, name: 'John', email: 'email' }]);

	await db.execute(sql`drop table ${usersMigratorTable}`);
	await db.execute(sql`drop table "drizzle"."__drizzle_migrations"`);
});

test.serial('insert via db.execute + select via db.execute', async (t) => {
	const { db } = t.context;

	await db.execute(sql`insert into ${usersTable} (${new Name(usersTable.name.name)}) values (${'John'})`);

	const result = await db.execute<{ id: number; name: string }>(sql`select id, name from "users"`);
	t.deepEqual(Array.prototype.slice.call(result), [{ id: 1, name: 'John' }]);
});

test.serial('insert via db.execute + returning', async (t) => {
	const { db } = t.context;

	const result = await db.execute<{ id: number; name: string }>(
		sql`insert into ${usersTable} (${new Name(
			usersTable.name.name,
		)}) values (${'John'}) returning ${usersTable.id}, ${usersTable.name}`,
	);
	t.deepEqual(Array.prototype.slice.call(result), [{ id: 1, name: 'John' }]);
});

test.serial('insert via db.execute w/ query builder', async (t) => {
	const { db } = t.context;

	const result = await db.execute<Pick<typeof usersTable['_']['model']['select'], 'id' | 'name'>>(
		db.insert(usersTable).values({ name: 'John' }).returning({ id: usersTable.id, name: usersTable.name }),
	);
	t.deepEqual(Array.prototype.slice.call(result), [{ id: 1, name: 'John' }]);
});

test.serial('Query check: Insert all defaults in 1 row', async (t) => {
	const { db } = t.context;

	const users = pgTable('users', {
		id: serial('id').primaryKey(),
		name: text('name').default('Dan'),
		state: text('state'),
	});

	const query = db
		.insert(users)
		.values({})
		.toSQL();

	t.deepEqual(query, {
		sql: 'insert into "users" ("id", "name", "state") values (default, default, default)',
		params: [],
	});
});

test.serial('Query check: Insert all defaults in multiple rows', async (t) => {
	const { db } = t.context;

	const users = pgTable('users', {
		id: serial('id').primaryKey(),
		name: text('name').default('Dan'),
		state: text('state').default('UA'),
	});

	const query = db
		.insert(users)
		.values([{}, {}])
		.toSQL();

	t.deepEqual(query, {
		sql: 'insert into "users" ("id", "name", "state") values (default, default, default), (default, default, default)',
		params: [],
	});
});

test.serial('Insert all defaults in 1 row', async (t) => {
	const { db } = t.context;

	const users = pgTable('empty_insert_single', {
		id: serial('id').primaryKey(),
		name: text('name').default('Dan'),
		state: text('state'),
	});

	await db.execute(sql`drop table if exists ${users}`);

	await db.execute(
		sql`create table ${users} (id serial primary key, name text default 'Dan', state text)`,
	);

	await db.insert(users).values({});

	const res = await db.select().from(users);

	t.deepEqual(res, [{ id: 1, name: 'Dan', state: null }]);
});

test.serial('Insert all defaults in multiple rows', async (t) => {
	const { db } = t.context;

	const users = pgTable('empty_insert_multiple', {
		id: serial('id').primaryKey(),
		name: text('name').default('Dan'),
		state: text('state'),
	});

	await db.execute(sql`drop table if exists ${users}`);

	await db.execute(
		sql`create table ${users} (id serial primary key, name text default 'Dan', state text)`,
	);

	await db.insert(users).values([{}, {}])

	const res = await db.select().from(users);

	t.deepEqual(res, [{ id: 1, name: 'Dan', state: null }, { id: 2, name: 'Dan', state: null }]);
});

test.serial('build query insert with onConflict do update', async (t) => {
	const { db } = t.context;

	const query = db.insert(usersTable)
		.values({ name: 'John', jsonb: ['foo', 'bar'] })
		.onConflictDoUpdate({ target: usersTable.id, set: { name: 'John1' } })
		.toSQL();

	t.deepEqual(query, {
		sql: 'insert into "users" ("id", "name", "verified", "jsonb", "created_at") values (default, $1, default, $2, default) on conflict ("id") do update set "name" = $3',
		params: ['John', '["foo","bar"]', 'John1'],
	});
});

test.serial('build query insert with onConflict do update / multiple columns', async (t) => {
	const { db } = t.context;

	const query = db.insert(usersTable)
		.values({ name: 'John', jsonb: ['foo', 'bar'] })
		.onConflictDoUpdate({ target: [usersTable.id, usersTable.name], set: { name: 'John1' } })
		.toSQL();

	t.deepEqual(query, {
		sql: 'insert into "users" ("id", "name", "verified", "jsonb", "created_at") values (default, $1, default, $2, default) on conflict ("id","name") do update set "name" = $3',
		params: ['John', '["foo","bar"]', 'John1'],
	});
});

test.serial('build query insert with onConflict do nothing', async (t) => {
	const { db } = t.context;

	const query = db.insert(usersTable)
		.values({ name: 'John', jsonb: ['foo', 'bar'] })
		.onConflictDoNothing()
		.toSQL();

	t.deepEqual(query, {
		sql: 'insert into "users" ("id", "name", "verified", "jsonb", "created_at") values (default, $1, default, $2, default) on conflict do nothing',
		params: ['John', '["foo","bar"]'],
	});
});

test.serial('build query insert with onConflict do nothing + target', async (t) => {
	const { db } = t.context;

	const query = db.insert(usersTable)
		.values({ name: 'John', jsonb: ['foo', 'bar'] })
		.onConflictDoNothing({ target: usersTable.id })
		.toSQL();

	t.deepEqual(query, {
		sql: 'insert into "users" ("id", "name", "verified", "jsonb", "created_at") values (default, $1, default, $2, default) on conflict ("id") do nothing',
		params: ['John', '["foo","bar"]'],
	});
});

test.serial('insert with onConflict do update', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable)
		.values({ name: 'John' });

	await db.insert(usersTable)
		.values({ id: 1, name: 'John' })
		.onConflictDoUpdate({ target: usersTable.id, set: { name: 'John1' } });

	const res = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(
		eq(usersTable.id, 1),
	);

	t.deepEqual(res, [{ id: 1, name: 'John1' }]);
});

test.serial('insert with onConflict do nothing', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable)
		.values({ name: 'John' });

	await db.insert(usersTable)
		.values({ id: 1, name: 'John' })
		.onConflictDoNothing();

	const res = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(
		eq(usersTable.id, 1),
	);

	t.deepEqual(res, [{ id: 1, name: 'John' }]);
});

test.serial('insert with onConflict do nothing + target', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable)
		.values({ name: 'John' });

	await db.insert(usersTable)
		.values({ id: 1, name: 'John' })
		.onConflictDoNothing({ target: usersTable.id });

	const res = await db.select({ id: usersTable.id, name: usersTable.name }).from(usersTable).where(
		eq(usersTable.id, 1),
	);

	t.deepEqual(res, [{ id: 1, name: 'John' }]);
});

test.serial('left join (flat object fields)', async (t) => {
	const { db } = t.context;

	const { id: cityId } = await db.insert(citiesTable)
		.values([{ name: 'Paris' }, { name: 'London' }])
		.returning({ id: citiesTable.id }).then((rows) => rows[0]!);

	await db.insert(users2Table).values([{ name: 'John', cityId }, { name: 'Jane' }]);

	const res = await db.select({
		userId: users2Table.id,
		userName: users2Table.name,
		cityId: citiesTable.id,
		cityName: citiesTable.name,
	}).from(users2Table)
		.leftJoin(citiesTable, eq(users2Table.cityId, citiesTable.id));

	t.deepEqual(res, [
		{ userId: 1, userName: 'John', cityId, cityName: 'Paris' },
		{ userId: 2, userName: 'Jane', cityId: null, cityName: null },
	]);
});

test.serial('left join (grouped fields)', async (t) => {
	const { db } = t.context;

	const { id: cityId } = await db.insert(citiesTable)
		.values([{ name: 'Paris' }, { name: 'London' }])
		.returning({ id: citiesTable.id }).then((rows) => rows[0]!);

	await db.insert(users2Table).values([{ name: 'John', cityId }, { name: 'Jane' }]);

	const res = await db.select({
		id: users2Table.id,
		user: {
			name: users2Table.name,
			nameUpper: sql<string>`upper(${users2Table.name})`,
		},
		city: {
			id: citiesTable.id,
			name: citiesTable.name,
			nameUpper: sql<string>`upper(${citiesTable.name})`,
		},
	}).from(users2Table)
		.leftJoin(citiesTable, eq(users2Table.cityId, citiesTable.id));

	t.deepEqual(res, [
		{
			id: 1,
			user: { name: 'John', nameUpper: 'JOHN' },
			city: { id: cityId, name: 'Paris', nameUpper: 'PARIS' },
		},
		{
			id: 2,
			user: { name: 'Jane', nameUpper: 'JANE' },
			city: null,
		},
	]);
});

test.serial('left join (all fields)', async (t) => {
	const { db } = t.context;

	const { id: cityId } = await db.insert(citiesTable)
		.values([{ name: 'Paris' }, { name: 'London' }])
		.returning({ id: citiesTable.id }).then((rows) => rows[0]!);

	await db.insert(users2Table).values([{ name: 'John', cityId }, { name: 'Jane' }]);

	const res = await db.select().from(users2Table)
		.leftJoin(citiesTable, eq(users2Table.cityId, citiesTable.id));

	t.deepEqual(res, [
		{
			users2: {
				id: 1,
				name: 'John',
				cityId,
			},
			cities: {
				id: cityId,
				name: 'Paris',
			},
		},
		{
			users2: {
				id: 2,
				name: 'Jane',
				cityId: null,
			},
			cities: null,
		},
	]);
});

test.serial('join subquery', async (t) => {
	const { db } = t.context;

	await db.insert(courseCategoriesTable).values([
		{ name: 'Category 1' },
		{ name: 'Category 2' },
		{ name: 'Category 3' },
		{ name: 'Category 4' },
	]);

	await db.insert(coursesTable).values([
		{ name: 'Development', categoryId: 2 },
		{ name: 'IT & Software', categoryId: 3 },
		{ name: 'Marketing', categoryId: 4 },
		{ name: 'Design', categoryId: 1 },
	]);

	const sq2 = db
		.select({
			categoryId: courseCategoriesTable.id,
			category: courseCategoriesTable.name,
			total: sql<number>`count(${courseCategoriesTable.id})`,
		})
		.from(courseCategoriesTable)
		.groupBy(courseCategoriesTable.id, courseCategoriesTable.name)
		.as('sq2');

	const res = await db
		.select({
			courseName: coursesTable.name,
			categoryId: sq2.categoryId,
		})
		.from(coursesTable)
		.leftJoin(sq2, eq(coursesTable.categoryId, sq2.categoryId))
		.orderBy(coursesTable.name);

	t.deepEqual(res, [
		{ courseName: 'Design', categoryId: 1 },
		{ courseName: 'Development', categoryId: 2 },
		{ courseName: 'IT & Software', categoryId: 3 },
		{ courseName: 'Marketing', categoryId: 4 },
	]);
});

test.serial('with ... select', async (t) => {
	const { db } = t.context;

	await db.insert(orders).values([
		{ region: 'Europe', product: 'A', amount: 10, quantity: 1 },
		{ region: 'Europe', product: 'A', amount: 20, quantity: 2 },
		{ region: 'Europe', product: 'B', amount: 20, quantity: 2 },
		{ region: 'Europe', product: 'B', amount: 30, quantity: 3 },
		{ region: 'US', product: 'A', amount: 30, quantity: 3 },
		{ region: 'US', product: 'A', amount: 40, quantity: 4 },
		{ region: 'US', product: 'B', amount: 40, quantity: 4 },
		{ region: 'US', product: 'B', amount: 50, quantity: 5 },
	]);

	const regionalSales = db
		.$with('regional_sales')
		.as(
			db.select({
				region: orders.region,
				totalSales: sql<number>`sum(${orders.amount})`.as('total_sales'),
			})
				.from(orders)
				.groupBy(orders.region),
		);

	const topRegions = db
		.$with('top_regions')
		.as(
			db
				.select({
					region: regionalSales.region,
				})
				.from(regionalSales)
				.where(
					gt(
						regionalSales.totalSales,
						db.select({ sales: sql`sum(${regionalSales.totalSales})/10` }).from(regionalSales),
					),
				),
		);

	const result = await db
		.with(regionalSales, topRegions)
		.select({
			region: orders.region,
			product: orders.product,
			productUnits: sql<number>`sum(${orders.quantity})::int`,
			productSales: sql<number>`sum(${orders.amount})::int`,
		})
		.from(orders)
		.where(inArray(orders.region, db.select({ region: topRegions.region }).from(topRegions)))
		.groupBy(orders.region, orders.product)
		.orderBy(orders.region, orders.product);

	t.deepEqual(result, [
		{
			region: 'Europe',
			product: 'A',
			productUnits: 3,
			productSales: 30,
		},
		{
			region: 'Europe',
			product: 'B',
			productUnits: 5,
			productSales: 50,
		},
		{
			region: 'US',
			product: 'A',
			productUnits: 7,
			productSales: 70,
		},
		{
			region: 'US',
			product: 'B',
			productUnits: 9,
			productSales: 90,
		},
	]);
});

test.serial('select from subquery sql', async (t) => {
	const { db } = t.context;

	await db.insert(users2Table).values([{ name: 'John' }, { name: 'Jane' }]);

	const sq = db
		.select({ name: sql<string>`${users2Table.name} || ' modified'`.as('name') })
		.from(users2Table)
		.as('sq');

	const res = await db.select({ name: sq.name }).from(sq);

	t.deepEqual(res, [{ name: 'John modified' }, { name: 'Jane modified' }]);
});

test.serial('select a field without joining its table', (t) => {
	const { db } = t.context;

	t.throws(() => db.select({ name: users2Table.name }).from(usersTable).prepare('query'));
});

test.serial('select all fields from subquery without alias', (t) => {
	const { db } = t.context;

	const sq = db.$with('sq').as(db.select({ name: sql<string>`upper(${users2Table.name})` }).from(users2Table));

	t.throws(() => db.select().from(sq).prepare('query'));
});

test.serial('select count()', async (t) => {
	const { db } = t.context;

	await db.insert(usersTable).values([{ name: 'John' }, { name: 'Jane' }]);

	const res = await db.select({ count: sql`count(*)` }).from(usersTable);

	t.deepEqual(res, [{ count: '2' }]);
});

test.serial('select count w/ custom mapper', async (t) => {
	const { db } = t.context;

	function count(value: AnyPgColumn | SQLWrapper): SQL<number>;
	function count(value: AnyPgColumn | SQLWrapper, alias: string): SQL.Aliased<number>;
	function count(value: AnyPgColumn | SQLWrapper, alias?: string): SQL<number> | SQL.Aliased<number> {
		const result = sql`count(${value})`.mapWith(Number);
		if (!alias) {
			return result;
		}
		return result.as(alias);
	}

	await db.insert(usersTable).values([{ name: 'John' }, { name: 'Jane' }]);

	const res = await db.select({ count: count(sql`*`) }).from(usersTable);

	t.deepEqual(res, [{ count: 2 }]);
});

test.serial('select for ...', (t) => {
	const { db } = t.context;

	const query = db
		.select()
		.from(users2Table)
		.for('update')
		.for('no key update', { of: users2Table })
		.for('no key update', { of: users2Table, skipLocked: true })
		.for('share', { of: users2Table, noWait: true })
		.toSQL();

	t.regex(
		query.sql,
		// eslint-disable-next-line unicorn/better-regex
		/select ("(id|name|city_id)"(, )?){3} from "users2" for update for no key update of "users2" for no key update of "users2" skip locked for share of "users2" no wait/,
	);
});

test.serial('having', async (t) => {
	const { db } = t.context;

	await db.insert(citiesTable).values([{ name: 'London' }, { name: 'Paris' }, { name: 'New York' }]);

	await db.insert(users2Table).values([{ name: 'John', cityId: 1 }, { name: 'Jane', cityId: 1 }, {
		name: 'Jack',
		cityId: 2,
	}]);

	const result = await db
		.select({
			id: citiesTable.id,
			name: sql<string>`upper(${citiesTable.name})`.as('upper_name'),
			usersCount: sql<number>`count(${users2Table.id})::int`.as('users_count'),
		})
		.from(citiesTable)
		.leftJoin(users2Table, eq(users2Table.cityId, citiesTable.id))
		.where(({ name }) => sql`length(${name}) >= 3`)
		.groupBy(citiesTable.id)
		.having(({ usersCount }) => sql`${usersCount} > 0`)
		.orderBy(({ name }) => name);

	t.deepEqual(result, [
		{
			id: 1,
			name: 'LONDON',
			usersCount: 2,
		},
		{
			id: 2,
			name: 'PARIS',
			usersCount: 1,
		},
	]);
});

test.serial('view', async (t) => {
	const { db } = t.context;

	const newYorkers1 = pgView('new_yorkers')
		.as((qb) => qb.select().from(users2Table).where(eq(users2Table.cityId, 1)));

	const newYorkers2 = pgView('new_yorkers', {
		id: serial('id').primaryKey(),
		name: text('name').notNull(),
		cityId: integer('city_id').notNull(),
	}).as(sql`select * from ${users2Table} where ${eq(users2Table.cityId, 1)}`);

	const newYorkers3 = pgView('new_yorkers', {
		id: serial('id').primaryKey(),
		name: text('name').notNull(),
		cityId: integer('city_id').notNull(),
	}).existing();

	await db.execute(sql`create view new_yorkers as ${getViewConfig(newYorkers1).query}`);

	await db.insert(citiesTable).values([{ name: 'New York' }, { name: 'Paris' }]);

	await db.insert(users2Table).values([
		{ name: 'John', cityId: 1 },
		{ name: 'Jane', cityId: 1 },
		{ name: 'Jack', cityId: 2 },
	]);

	{
		const result = await db.select().from(newYorkers1);
		t.deepEqual(result, [
			{ id: 1, name: 'John', cityId: 1 },
			{ id: 2, name: 'Jane', cityId: 1 },
		]);
	}

	{
		const result = await db.select().from(newYorkers2);
		t.deepEqual(result, [
			{ id: 1, name: 'John', cityId: 1 },
			{ id: 2, name: 'Jane', cityId: 1 },
		]);
	}

	{
		const result = await db.select().from(newYorkers3);
		t.deepEqual(result, [
			{ id: 1, name: 'John', cityId: 1 },
			{ id: 2, name: 'Jane', cityId: 1 },
		]);
	}

	{
		const result = await db.select({ name: newYorkers1.name }).from(newYorkers1);
		t.deepEqual(result, [
			{ name: 'John' },
			{ name: 'Jane' },
		]);
	}

	await db.execute(sql`drop view ${newYorkers1}`);
});

test.serial('materialized view', async (t) => {
	const { db } = t.context;

	const newYorkers1 = pgMaterializedView('new_yorkers')
		.as((qb) => qb.select().from(users2Table).where(eq(users2Table.cityId, 1)));

	const newYorkers2 = pgMaterializedView('new_yorkers', {
		id: serial('id').primaryKey(),
		name: text('name').notNull(),
		cityId: integer('city_id').notNull(),
	}).as(sql`select * from ${users2Table} where ${eq(users2Table.cityId, 1)}`);

	const newYorkers3 = pgMaterializedView('new_yorkers', {
		id: serial('id').primaryKey(),
		name: text('name').notNull(),
		cityId: integer('city_id').notNull(),
	}).existing();

	await db.execute(sql`create materialized view ${newYorkers1} as ${getMaterializedViewConfig(newYorkers1).query}`);

	await db.insert(citiesTable).values([{ name: 'New York' }, { name: 'Paris' }]);

	await db.insert(users2Table).values([
		{ name: 'John', cityId: 1 },
		{ name: 'Jane', cityId: 1 },
		{ name: 'Jack', cityId: 2 },
	]);

	{
		const result = await db.select().from(newYorkers1);
		t.deepEqual(result, []);
	}

	await db.refreshMaterializedView(newYorkers1);

	{
		const result = await db.select().from(newYorkers1);
		t.deepEqual(result, [
			{ id: 1, name: 'John', cityId: 1 },
			{ id: 2, name: 'Jane', cityId: 1 },
		]);
	}

	{
		const result = await db.select().from(newYorkers2);
		t.deepEqual(result, [
			{ id: 1, name: 'John', cityId: 1 },
			{ id: 2, name: 'Jane', cityId: 1 },
		]);
	}

	{
		const result = await db.select().from(newYorkers3);
		t.deepEqual(result, [
			{ id: 1, name: 'John', cityId: 1 },
			{ id: 2, name: 'Jane', cityId: 1 },
		]);
	}

	{
		const result = await db.select({ name: newYorkers1.name }).from(newYorkers1);
		t.deepEqual(result, [
			{ name: 'John' },
			{ name: 'Jane' },
		]);
	}

	await db.execute(sql`drop materialized view ${newYorkers1}`);
});

test.serial('select from raw sql', async (t) => {
	const { db } = t.context;

	const result = await db.select({
		id: sql<number>`id`,
		name: sql<string>`name`,
	}).from(sql`(select 1 as id, 'John' as name) as users`);

	Expect<Equal<{ id: number; name: string }[], typeof result>>;

	t.deepEqual(result, [
		{ id: 1, name: 'John' },
	]);
});

test.serial('select from raw sql with joins', async (t) => {
	const { db } = t.context;

	const result = await db
		.select({
			id: sql<number>`users.id`,
			name: sql<string>`users.name`,
			userCity: sql<string>`users.city`,
			cityName: sql<string>`cities.name`,
		})
		.from(sql`(select 1 as id, 'John' as name, 'New York' as city) as users`)
		.leftJoin(sql`(select 1 as id, 'Paris' as name) as cities`, sql`cities.id = users.id`);

	Expect<Equal<{ id: number; name: string; userCity: string; cityName: string }[], typeof result>>;

	t.deepEqual(result, [
		{ id: 1, name: 'John', userCity: 'New York', cityName: 'Paris' },
	]);
});

test.serial('join on aliased sql from select', async (t) => {
	const { db } = t.context;

	const result = await db
		.select({
			userId: sql<number>`users.id`.as('userId'),
			name: sql<string>`users.name`,
			userCity: sql<string>`users.city`,
			cityId: sql<number>`cities.id`.as('cityId'),
			cityName: sql<string>`cities.name`,
		})
		.from(sql`(select 1 as id, 'John' as name, 'New York' as city) as users`)
		.leftJoin(sql`(select 1 as id, 'Paris' as name) as cities`, (cols) => eq(cols.cityId, cols.userId));

	Expect<Equal<{ userId: number; name: string; userCity: string; cityId: number; cityName: string }[], typeof result>>;

	t.deepEqual(result, [
		{ userId: 1, name: 'John', userCity: 'New York', cityId: 1, cityName: 'Paris' },
	]);
});

test.serial('join on aliased sql from with clause', async (t) => {
	const { db } = t.context;

	const users = db.$with('users').as(
		db.select({
			id: sql<number>`id`.as('userId'),
			name: sql<string>`name`.as('userName'),
			city: sql<string>`city`.as('city'),
		}).from(
			sql`(select 1 as id, 'John' as name, 'New York' as city) as users`,
		),
	);

	const cities = db.$with('cities').as(
		db.select({
			id: sql<number>`id`.as('cityId'),
			name: sql<string>`name`.as('cityName'),
		}).from(
			sql`(select 1 as id, 'Paris' as name) as cities`,
		),
	);

	const result = await db
		.with(users, cities)
		.select({
			userId: users.id,
			name: users.name,
			userCity: users.city,
			cityId: cities.id,
			cityName: cities.name,
		})
		.from(users)
		.leftJoin(cities, (cols) => eq(cols.cityId, cols.userId));

	Expect<Equal<{ userId: number; name: string; userCity: string; cityId: number; cityName: string }[], typeof result>>;

	t.deepEqual(result, [
		{ userId: 1, name: 'John', userCity: 'New York', cityId: 1, cityName: 'Paris' },
	]);
});

test.serial('prefixed table', async (t) => {
	const { db } = t.context;

	const pgTable = pgTableCreator((name) => `myprefix_${name}`);

	const users = pgTable('test_prefixed_table_with_unique_name', {
		id: integer('id').primaryKey(),
		name: text('name').notNull(),
	});

	await db.execute(sql`drop table if exists ${users}`);

	await db.execute(
		sql`create table myprefix_test_prefixed_table_with_unique_name (id integer not null primary key, name text not null)`,
	);

	await db.insert(users).values({ id: 1, name: 'John' });

	const result = await db.select().from(users);

	t.deepEqual(result, [{ id: 1, name: 'John' }]);

	await db.execute(sql`drop table ${users}`);
});

test.serial('select from enum', async (t) => {
	const { db } = t.context;

	const muscleEnum = pgEnum('muscle', [
		'abdominals',
		'hamstrings',
		'adductors',
		'quadriceps',
		'biceps',
		'shoulders',
		'chest',
		'middle_back',
		'calves',
		'glutes',
		'lower_back',
		'lats',
		'triceps',
		'traps',
		'forearms',
		'neck',
		'abductors',
	]);

	const forceEnum = pgEnum('force', ['isometric', 'isotonic', 'isokinetic']);

	const levelEnum = pgEnum('level', ['beginner', 'intermediate', 'advanced']);

	const mechanicEnum = pgEnum('mechanic', ['compound', 'isolation']);

	const equipmentEnum = pgEnum('equipment', ['barbell', 'dumbbell', 'bodyweight', 'machine', 'cable', 'kettlebell']);

	const categoryEnum = pgEnum('category', ['upper_body', 'lower_body', 'full_body']);

	const exercises = pgTable('exercises', {
		id: serial('id').primaryKey(),
		name: varchar('name').notNull(),
		force: forceEnum('force'),
		level: levelEnum('level'),
		mechanic: mechanicEnum('mechanic'),
		equipment: equipmentEnum('equipment'),
		instructions: text('instructions'),
		category: categoryEnum('category'),
		primaryMuscles: muscleEnum('primary_muscles').array(),
		secondaryMuscles: muscleEnum('secondary_muscles').array(),
		createdAt: timestamp('created_at').notNull().default(sql`now()`),
		updatedAt: timestamp('updated_at').notNull().default(sql`now()`),
	});

	await db.execute(sql`drop table if exists ${exercises}`);
	await db.execute(sql`drop type if exists ${name(muscleEnum.enumName)}`);
	await db.execute(sql`drop type if exists ${name(forceEnum.enumName)}`);
	await db.execute(sql`drop type if exists ${name(levelEnum.enumName)}`);
	await db.execute(sql`drop type if exists ${name(mechanicEnum.enumName)}`);
	await db.execute(sql`drop type if exists ${name(equipmentEnum.enumName)}`);
	await db.execute(sql`drop type if exists ${name(categoryEnum.enumName)}`);

	await db.execute(
		sql`create type ${
			name(muscleEnum.enumName)
		} as enum ('abdominals', 'hamstrings', 'adductors', 'quadriceps', 'biceps', 'shoulders', 'chest', 'middle_back', 'calves', 'glutes', 'lower_back', 'lats', 'triceps', 'traps', 'forearms', 'neck', 'abductors')`,
	);
	await db.execute(sql`create type ${name(forceEnum.enumName)} as enum ('isometric', 'isotonic', 'isokinetic')`);
	await db.execute(sql`create type ${name(levelEnum.enumName)} as enum ('beginner', 'intermediate', 'advanced')`);
	await db.execute(sql`create type ${name(mechanicEnum.enumName)} as enum ('compound', 'isolation')`);
	await db.execute(
		sql`create type ${
			name(equipmentEnum.enumName)
		} as enum ('barbell', 'dumbbell', 'bodyweight', 'machine', 'cable', 'kettlebell')`,
	);
	await db.execute(sql`create type ${name(categoryEnum.enumName)} as enum ('upper_body', 'lower_body', 'full_body')`);
	await db.execute(sql`
		create table ${exercises} (
			id serial primary key,
			name varchar not null,
			force force,
			level level,
			mechanic mechanic,
			equipment equipment,
			instructions text,
			category category,
			primary_muscles muscle[],
			secondary_muscles muscle[],
			created_at timestamp not null default now(),
			updated_at timestamp not null default now()
		)
	`);

	await db.insert(exercises).values({
		name: 'Bench Press',
		force: 'isotonic',
		level: 'beginner',
		mechanic: 'compound',
		equipment: 'barbell',
		instructions:
			'Lie on your back on a flat bench. Grasp the barbell with an overhand grip, slightly wider than shoulder width. Unrack the barbell and hold it over you with your arms locked. Lower the barbell to your chest. Press the barbell back to the starting position.',
		category: 'upper_body',
		primaryMuscles: ['chest', 'triceps'],
		secondaryMuscles: ['shoulders', 'traps'],
	});

	const result = await db.select().from(exercises);

	t.deepEqual(result, [
		{
			id: 1,
			name: 'Bench Press',
			force: 'isotonic',
			level: 'beginner',
			mechanic: 'compound',
			equipment: 'barbell',
			instructions:
				'Lie on your back on a flat bench. Grasp the barbell with an overhand grip, slightly wider than shoulder width. Unrack the barbell and hold it over you with your arms locked. Lower the barbell to your chest. Press the barbell back to the starting position.',
			category: 'upper_body',
			primaryMuscles: ['chest', 'triceps'],
			secondaryMuscles: ['shoulders', 'traps'],
			createdAt: result[0]!.createdAt,
			updatedAt: result[0]!.updatedAt,
		},
	]);

	await db.execute(sql`drop table ${exercises}`);
	await db.execute(sql`drop type ${name(muscleEnum.enumName)}`);
	await db.execute(sql`drop type ${name(forceEnum.enumName)}`);
	await db.execute(sql`drop type ${name(levelEnum.enumName)}`);
	await db.execute(sql`drop type ${name(mechanicEnum.enumName)}`);
	await db.execute(sql`drop type ${name(equipmentEnum.enumName)}`);
	await db.execute(sql`drop type ${name(categoryEnum.enumName)}`);
});

test.serial('orderBy with aliased column', (t) => {
	const { db } = t.context;

	const query = db.select({
		test: sql`something`.as('test'),
	}).from(users2Table).orderBy((fields) => fields.test).toSQL();

	t.deepEqual(query.sql, 'select something as "test" from "users2" order by "test"');
});

test.serial('select from sql', async (t) => {
	const { db } = t.context;

	const metricEntry = pgTable('metric_entry', {
		id: pgUuid('id').notNull(),
		createdAt: timestamp('created_at').notNull(),
	});

	await db.execute(sql`drop table if exists ${metricEntry}`);
	await db.execute(sql`create table ${metricEntry} (id uuid not null, created_at timestamp not null)`);

	const metricId = uuid();

	const intervals = db.$with('intervals').as(
		db
			.select({
				startTime: sql<string>`(date'2023-03-01'+ x * '1 day'::interval)`.as('start_time'),
				endTime: sql<string>`(date'2023-03-01'+ (x+1) *'1 day'::interval)`.as('end_time'),
			})
			.from(sql`generate_series(0, 29, 1) as t(x)`),
	);

	await t.notThrowsAsync(() =>
		db
			.with(intervals)
			.select({
				startTime: intervals.startTime,
				endTime: intervals.endTime,
				count: sql<number>`count(${metricEntry})`,
			})
			.from(metricEntry)
			.rightJoin(
				intervals,
				and(
					eq(metricEntry.id, metricId),
					gte(metricEntry.createdAt, intervals.startTime),
					lt(metricEntry.createdAt, intervals.endTime),
				),
			)
			.groupBy(intervals.startTime, intervals.endTime)
			.orderBy(asc(intervals.startTime))
	);
	// beta
});

test.serial('transaction', async (t) => {
	const { db } = t.context;

	const users = pgTable('users_transactions', {
		id: serial('id').primaryKey(),
		balance: integer('balance').notNull(),
	});
	const products = pgTable('products_transactions', {
		id: serial('id').primaryKey(),
		price: integer('price').notNull(),
		stock: integer('stock').notNull(),
	});

	await db.execute(sql`drop table if exists ${users}`);
	await db.execute(sql`drop table if exists ${products}`);

	await db.execute(sql`create table users_transactions (id serial not null primary key, balance integer not null)`);
	await db.execute(
		sql`create table products_transactions (id serial not null primary key, price integer not null, stock integer not null)`,
	);

	const user = await db.insert(users).values({ balance: 100 }).returning().then((rows) => rows[0]!);
	const product = await db.insert(products).values({ price: 10, stock: 10 }).returning().then((rows) => rows[0]!);

	await db.transaction(async (tx) => {
		await tx.update(users).set({ balance: user.balance - product.price }).where(eq(users.id, user.id));
		await tx.update(products).set({ stock: product.stock - 1 }).where(eq(products.id, product.id));
	});

	const result = await db.select().from(users);

	t.deepEqual(result, [{ id: 1, balance: 90 }]);

	await db.execute(sql`drop table ${users}`);
	await db.execute(sql`drop table ${products}`);
});

test.serial('transaction rollback', async (t) => {
	const { db } = t.context;

	const users = pgTable('users_transactions_rollback', {
		id: serial('id').primaryKey(),
		balance: integer('balance').notNull(),
	});

	await db.execute(sql`drop table if exists ${users}`);

	await db.execute(
		sql`create table users_transactions_rollback (id serial not null primary key, balance integer not null)`,
	);

	await t.throwsAsync(async () =>
		await db.transaction(async (tx) => {
			await tx.insert(users).values({ balance: 100 });
			await tx.rollback();
		}), new DrizzleError('Rollback'));

	const result = await db.select().from(users);

	t.deepEqual(result, []);

	await db.execute(sql`drop table ${users}`);
});

test.serial('nested transaction', async (t) => {
	const { db } = t.context;

	const users = pgTable('users_nested_transactions', {
		id: serial('id').primaryKey(),
		balance: integer('balance').notNull(),
	});

	await db.execute(sql`drop table if exists ${users}`);

	await db.execute(
		sql`create table users_nested_transactions (id serial not null primary key, balance integer not null)`,
	);

	await db.transaction(async (tx) => {
		await tx.insert(users).values({ balance: 100 });

		await tx.transaction(async (tx) => {
			await tx.update(users).set({ balance: 200 });
		});
	});

	const result = await db.select().from(users);

	t.deepEqual(result, [{ id: 1, balance: 200 }]);

	await db.execute(sql`drop table ${users}`);
});

test.serial('nested transaction rollback', async (t) => {
	const { db } = t.context;

	const users = pgTable('users_nested_transactions_rollback', {
		id: serial('id').primaryKey(),
		balance: integer('balance').notNull(),
	});

	await db.execute(sql`drop table if exists ${users}`);

	await db.execute(
		sql`create table users_nested_transactions_rollback (id serial not null primary key, balance integer not null)`,
	);

	await db.transaction(async (tx) => {
		await tx.insert(users).values({ balance: 100 });

		await t.throwsAsync(async () =>
			await tx.transaction(async (tx) => {
				await tx.update(users).set({ balance: 200 });
				await tx.rollback();
			}), new DrizzleError('Rollback'));
	});

	const result = await db.select().from(users);

	t.deepEqual(result, [{ id: 1, balance: 100 }]);

	await db.execute(sql`drop table ${users}`);
});

test.serial('join subquery with join', async (t) => {
	const { db } = t.context;

	const internalStaff = pgTable('internal_staff', {
		userId: integer('user_id').notNull(),
	});

	const customUser = pgTable('custom_user', {
		id: integer('id').notNull(),
	});

	const ticket = pgTable('ticket', {
		staffId: integer('staff_id').notNull(),
	});

	await db.execute(sql`drop table if exists ${internalStaff}`);
	await db.execute(sql`drop table if exists ${customUser}`);
	await db.execute(sql`drop table if exists ${ticket}`);

	await db.execute(sql`create table internal_staff (user_id integer not null)`);
	await db.execute(sql`create table custom_user (id integer not null)`);
	await db.execute(sql`create table ticket (staff_id integer not null)`);

	await db.insert(internalStaff).values({ userId: 1 });
	await db.insert(customUser).values({ id: 1 });
	await db.insert(ticket).values({ staffId: 1 });

	const subq = db
		.select()
		.from(internalStaff)
		.leftJoin(customUser, eq(internalStaff.userId, customUser.id))
		.as('internal_staff');

	const mainQuery = await db
		.select()
		.from(ticket)
		.leftJoin(subq, eq(subq.internal_staff.userId, ticket.staffId));

	t.deepEqual(mainQuery, [{
		ticket: { staffId: 1 },
		internal_staff: {
			internal_staff: { userId: 1 },
			custom_user: { id: 1 },
		},
	}]);

	await db.execute(sql`drop table ${internalStaff}`);
	await db.execute(sql`drop table ${customUser}`);
	await db.execute(sql`drop table ${ticket}`);
});

test.serial('join view as subquery', async (t) => {
	const { db } = t.context;

	const users = pgTable('users_join_view', {
		id: serial('id').primaryKey(),
		name: text('name').notNull(),
		cityId: integer('city_id').notNull(),
	});

	const newYorkers = pgView('new_yorkers').as((qb) => qb.select().from(users).where(eq(users.cityId, 1)));

	await db.execute(sql`drop table if exists ${users}`);
	await db.execute(sql`drop view if exists ${newYorkers}`);

	await db.execute(
		sql`create table ${users} (id serial not null primary key, name text not null, city_id integer not null)`,
	);
	await db.execute(sql`create view ${newYorkers} as select * from ${users} where city_id = 1`);

	await db.insert(users).values([
		{ name: 'John', cityId: 1 },
		{ name: 'Jane', cityId: 2 },
		{ name: 'Jack', cityId: 1 },
		{ name: 'Jill', cityId: 2 },
	]);

	const sq = db.select().from(newYorkers).as('new_yorkers_sq');

	const result = await db.select().from(users).leftJoin(sq, eq(users.id, sq.id));

	t.deepEqual(result, [
		{
			users_join_view: { id: 1, name: 'John', cityId: 1 },
			new_yorkers_sq: { id: 1, name: 'John', cityId: 1 },
		},
		{
			users_join_view: { id: 2, name: 'Jane', cityId: 2 },
			new_yorkers_sq: null,
		},
		{
			users_join_view: { id: 3, name: 'Jack', cityId: 1 },
			new_yorkers_sq: { id: 3, name: 'Jack', cityId: 1 },
		},
		{
			users_join_view: { id: 4, name: 'Jill', cityId: 2 },
			new_yorkers_sq: null,
		},
	]);

	await db.execute(sql`drop view ${newYorkers}`);
	await db.execute(sql`drop table ${users}`);
});

test.serial('insert undefined', async (t) => {
	const { db } = t.context;

	const users = pgTable('users', {
		id: serial('id').primaryKey(),
		name: text('name'),
	});

	await db.execute(sql`drop table if exists ${users}`);

	await db.execute(
		sql`create table ${users} (id serial not null primary key, name text)`,
	);

	await t.notThrowsAsync(async () => await db.insert(users).values({ name: undefined }));

	await db.execute(sql`drop table ${users}`);
});

test.serial('update undefined', async (t) => {
	const { db } = t.context;

	const users = pgTable('users', {
		id: serial('id').primaryKey(),
		name: text('name'),
	});

	await db.execute(sql`drop table if exists ${users}`);

	await db.execute(
		sql`create table ${users} (id serial not null primary key, name text)`,
	);

	await t.throwsAsync(async () => await db.update(users).set({ name: undefined }));
	await t.notThrowsAsync(async () => await db.update(users).set({ id: 1, name: undefined }));

	await db.execute(sql`drop table ${users}`);
});
