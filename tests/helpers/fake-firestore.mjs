// 노드 레인용 **최소 가짜 Firestore**.
//
// 왜: 이 레포의 읽기 비용·집계 술어 계약 상당수가 "소스 문자열 매칭" 으로만 잠겨 있었다
// (regex 가 통과해도 값이 틀릴 수 있다). 에뮬레이터는 read 과금을 재현하지 않고 노드 레인에서
// 돌지도 않으므로, 주입 가능한 코드 경로는 이 가짜로 **행위**를 잰다.
//
// 지원 범위는 의도적으로 좁다 — 필요해질 때만 넓힌다:
//   collection(name).where(field, op, value).orderBy(field).select(...f).limit(n).startAfter(doc).get()
//   collection(name).doc(id).get() / doc(path).get()
//   collection(name)....count().get()
//   runTransaction(fn) — tx.get(ref) / tx.set(ref, data, { merge })
//
// 읽은 문서 수(`stats.documentReads`)와 발행된 쿼리(`stats.queries`)를 기록하므로
// "예산을 넘겨 읽지 않았다" 같은 명제를 값으로 단언할 수 있다.

export const fakeFieldPath = { documentId: () => "__name__" };

function fieldValue(data, field, id) {
  if (field === "__name__") return id;
  return data?.[field];
}

function matches(data, id, clause) {
  const actual = fieldValue(data, clause.field, id);
  switch (clause.op) {
    case "==":
      return actual === clause.value;
    case "!=":
      return actual !== clause.value;
    case "in":
      return Array.isArray(clause.value) && clause.value.includes(actual);
    case "not-in":
      return Array.isArray(clause.value) && !clause.value.includes(actual);
    case ">":
      return actual !== undefined && actual !== null && actual > clause.value;
    case ">=":
      return actual !== undefined && actual !== null && actual >= clause.value;
    case "<":
      return actual !== undefined && actual !== null && actual < clause.value;
    case "<=":
      return actual !== undefined && actual !== null && actual <= clause.value;
    case "array-contains":
      return Array.isArray(actual) && actual.includes(clause.value);
    default:
      throw new Error(`fake-firestore: unsupported operator ${clause.op}`);
  }
}

function project(data, fields) {
  if (!fields || fields.length === 0) return { ...data };
  const out = {};
  for (const field of fields) {
    if (field === "__name__") continue;
    if (Object.prototype.hasOwnProperty.call(data, field)) out[field] = data[field];
  }
  return out;
}

class FakeQuery {
  constructor(store, stats, collection, spec = {}) {
    this.store = store;
    this.stats = stats;
    this.collection = collection;
    this.spec = { clauses: [], orderBy: null, fields: null, limit: null, after: null, ...spec };
  }

  #next(patch) {
    return new FakeQuery(this.store, this.stats, this.collection, { ...this.spec, ...patch });
  }

  where(field, op, value) {
    return this.#next({ clauses: [...this.spec.clauses, { field, op, value }] });
  }

  orderBy(field) {
    // FieldPath.documentId() 같은 비문자열 정렬축은 문서 id 정렬로 좁혀 해석한다
    // (필드명 FieldPath 는 이 가짜의 지원 범위 밖 — 필요해지면 그때 넓힌다).
    return this.#next({ orderBy: typeof field === "string" ? field : "__name__" });
  }

  select(...fields) {
    return this.#next({ fields });
  }

  limit(count) {
    return this.#next({ limit: count });
  }

  startAfter(cursor) {
    return this.#next({ after: typeof cursor === "string" ? cursor : cursor?.id });
  }

  #resolve() {
    const rows = [...(this.store.get(this.collection) ?? new Map()).entries()]
      .map(([id, data]) => ({ id, data }))
      .filter(({ id, data }) => this.spec.clauses.every((clause) => matches(data, id, clause)));
    const orderField = this.spec.orderBy ?? "__name__";
    rows.sort((left, right) => {
      const a = fieldValue(left.data, orderField, left.id);
      const b = fieldValue(right.data, orderField, right.id);
      if (a === b) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      return a < b ? -1 : 1;
    });
    const after = this.spec.after;
    const started = after ? rows.slice(rows.findIndex((row) => row.id === after) + 1) : rows;
    return this.spec.limit === null ? started : started.slice(0, this.spec.limit);
  }

  async get() {
    const rows = this.#resolve();
    this.stats.documentReads += rows.length;
    this.stats.queries.push({
      collection: this.collection,
      clauses: this.spec.clauses.map((clause) => ({ ...clause })),
      limit: this.spec.limit,
      returned: rows.length,
    });
    return {
      empty: rows.length === 0,
      size: rows.length,
      docs: rows.map(({ id, data }) => ({
        id,
        ref: { path: `${this.collection}/${id}` },
        exists: true,
        data: () => project(data, this.spec.fields),
      })),
    };
  }

  count() {
    const query = this;
    return {
      async get() {
        const rows = query.#resolve();
        query.stats.aggregateReads += 1;
        return { data: () => ({ count: rows.length }) };
      },
    };
  }
}

class FakeDocRef {
  constructor(store, stats, collection, id) {
    this.store = store;
    this.stats = stats;
    this.collection = collection;
    this.id = id;
    this.path = `${collection}/${id}`;
  }

  snapshot() {
    const data = (this.store.get(this.collection) ?? new Map()).get(this.id);
    this.stats.documentReads += 1;
    return {
      id: this.id,
      ref: { path: this.path },
      exists: data !== undefined,
      data: () => (data === undefined ? undefined : { ...data }),
    };
  }

  async get() {
    return this.snapshot();
  }

  applySet(patch, options = {}) {
    const collection = this.store.get(this.collection) ?? new Map();
    const previous = options.merge ? (collection.get(this.id) ?? {}) : {};
    collection.set(this.id, { ...previous, ...patch });
    this.store.set(this.collection, collection);
    this.stats.writes.push({ path: this.path, patch: { ...patch }, merge: options.merge === true });
  }

  async set(patch, options) {
    this.applySet(patch, options);
  }

  // 실 Firestore WriteBatch.create() 와 같은 의미: 문서가 이미 존재하면(커밋 시점에 다시 확인)
  // 실패한다 — 동시성 존재-레이스를 조용히 덮어쓰는 대신 fail-closed 로 막는 테스트용 가짜.
  applyCreate(data) {
    const collection = this.store.get(this.collection) ?? new Map();
    if (collection.has(this.id)) {
      const error = new Error(`fake-firestore: create() failed — document already exists: ${this.path}`);
      error.code = 6; // gRPC ALREADY_EXISTS, matches real Firestore's WriteBatch.create() failure code.
      throw error;
    }
    collection.set(this.id, { ...data });
    this.store.set(this.collection, collection);
    this.stats.writes.push({ path: this.path, patch: { ...data }, merge: false, create: true });
  }

  async create(data) {
    this.applyCreate(data);
  }
}

class FakeCollection extends FakeQuery {
  doc(id) {
    return new FakeDocRef(this.store, this.stats, this.collection, id);
  }
}

/**
 * @param seed `{ collectionName: { docId: data } }`
 */
export function createFakeFirestore(seed = {}) {
  const store = new Map();
  for (const [collection, docs] of Object.entries(seed)) {
    store.set(collection, new Map(Object.entries(docs).map(([id, data]) => [id, { ...data }])));
  }
  const stats = { documentReads: 0, aggregateReads: 0, queries: [], writes: [], transactions: 0 };

  const db = {
    stats,
    store,
    collection(name) {
      return new FakeCollection(store, stats, name);
    },
    doc(path) {
      const segments = path.split("/").filter(Boolean);
      if (segments.length !== 2) throw new Error(`fake-firestore: doc(path) expects <collection>/<id>, got ${path}`);
      return new FakeDocRef(store, stats, segments[0], segments[1]);
    },
    /** db.getAll(...refs) — 배치 문서 읽기. */
    async getAll(...refs) {
      return refs.map((ref) => ref.snapshot());
    },
    /** db.batch() — set/update/delete 를 모아 commit 시점에 일괄 적용한다. */
    batch() {
      const ops = [];
      return {
        set(ref, data, options) {
          ops.push({ kind: "set", ref, data, options });
        },
        create(ref, data) {
          ops.push({ kind: "create", ref, data });
        },
        update(ref, data) {
          ops.push({ kind: "update", ref, data });
        },
        delete(ref) {
          ops.push({ kind: "delete", ref });
        },
        async commit() {
          for (const op of ops) {
            if (op.kind === "set") {
              // set 의 merge 플래그를 그대로 존중한다(merge 없는 set = 덮어쓰기).
              op.ref.applySet(op.data, op.options ?? {});
            } else if (op.kind === "create") {
              // create = 문서가 이미 존재하면 커밋 시점에 실패(전체 배치 롤백) — 실 Firestore 와
              // 같은 fail-closed 존재 선결조건.
              op.ref.applyCreate(op.data);
            } else if (op.kind === "update") {
              // update = 필드 단위 병합 — merge set 과 같은 가짜 의미로 충분하다.
              op.ref.applySet(op.data, { merge: true });
            } else if (op.kind === "delete") {
              const collection = store.get(op.ref.collection);
              if (collection) collection.delete(op.ref.id);
            }
          }
        },
      };
    },
    async runTransaction(operation) {
      stats.transactions += 1;
      return operation({
        get: async (ref) => ref.snapshot(),
        set: (ref, patch, options) => ref.applySet(patch, options),
      });
    },
    /** 테스트 편의: 현재 문서를 그대로 읽는다(읽기 계측에 넣지 않는다). */
    peek(collection, id) {
      const data = (store.get(collection) ?? new Map()).get(id);
      return data === undefined ? undefined : { ...data };
    },
  };
  return db;
}
