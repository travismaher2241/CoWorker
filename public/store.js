// Data layer. Two interchangeable stores with the same shape:
//  - firebaseStore: Google sign-in + Cloud Firestore (what the live site uses)
//  - localStore: this browser only, for trying the app out (?demo in the URL)
//
// Firestore layout (one private space per signed-in user):
//   users/{uid}                 -> { settings: { nudgeAfterDays } }
//   users/{uid}/requests/{id}   -> a "waiting on" item
//   users/{uid}/todos/{id}      -> a to-do

const FIREBASE_VERSION = '10.14.1';
const CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

export const DEFAULT_SETTINGS = { nudgeAfterDays: 2 };

const strip = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

export async function firebaseStore(config) {
  const [{ initializeApp }, authMod, fs] = await Promise.all([
    import(`${CDN}/firebase-app.js`),
    import(`${CDN}/firebase-auth.js`),
    import(`${CDN}/firebase-firestore.js`),
  ]);
  const app = initializeApp(config);
  const auth = authMod.getAuth(app);
  let db;
  try {
    // Offline cache: the app still opens and shows your list on a flaky connection.
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    db = fs.getFirestore(app);
  }

  let uid = null;
  let unsubs = [];
  const col = (name) => fs.collection(db, 'users', uid, name);
  const ref = (name, id) => fs.doc(db, 'users', uid, name, id);

  return {
    kind: 'firebase',
    onUser(cb) {
      return authMod.onAuthStateChanged(auth, (user) => {
        uid = user ? user.uid : null;
        cb(user ? { uid: user.uid, email: user.email, name: user.displayName } : null);
      });
    },
    signIn: () => authMod.signInWithPopup(auth, new authMod.GoogleAuthProvider()),
    signOut: () => authMod.signOut(auth),
    getIdToken: () => auth.currentUser?.getIdToken() ?? Promise.resolve(null),

    subscribe(onChange, onError) {
      unsubs.forEach((u) => u());
      const data = { requests: [], todos: [], settings: { ...DEFAULT_SETTINGS } };
      const emit = () => onChange(data);
      unsubs = [
        fs.onSnapshot(col('requests'), (snap) => {
          data.requests = snap.docs.map((d) => ({ followUps: [], ...d.data(), id: d.id }));
          emit();
        }, onError),
        fs.onSnapshot(col('todos'), (snap) => {
          data.todos = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
          emit();
        }, onError),
        fs.onSnapshot(fs.doc(db, 'users', uid), (snap) => {
          data.settings = { ...DEFAULT_SETTINGS, ...(snap.data()?.settings || {}) };
          emit();
        }, onError),
      ];
      return () => unsubs.forEach((u) => u());
    },

    addRequest: (item) => fs.addDoc(col('requests'), strip(item)),
    updateRequest: (id, patch) => fs.updateDoc(ref('requests', id), strip(patch)),
    deleteRequest: (id) => fs.deleteDoc(ref('requests', id)),
    addTodo: (item) => fs.addDoc(col('todos'), strip(item)),
    updateTodo: (id, patch) => fs.updateDoc(ref('todos', id), strip(patch)),
    deleteTodo: (id) => fs.deleteDoc(ref('todos', id)),
    async deleteTodos(ids) {
      for (let i = 0; i < ids.length; i += 400) {
        const batch = fs.writeBatch(db);
        ids.slice(i, i + 400).forEach((id) => batch.delete(ref('todos', id)));
        await batch.commit();
      }
    },
    saveSettings: (settings) => fs.setDoc(fs.doc(db, 'users', uid), { settings }, { merge: true }),
  };
}

export function localStore() {
  const KEY = 'coworker-demo';
  const read = () => {
    try {
      const d = JSON.parse(localStorage.getItem(KEY)) || {};
      return { requests: d.requests || [], todos: d.todos || [], settings: { ...DEFAULT_SETTINGS, ...d.settings } };
    } catch {
      return { requests: [], todos: [], settings: { ...DEFAULT_SETTINGS } };
    }
  };
  let data = read();
  let listener = () => {};
  const commit = () => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
    listener(structuredClone(data));
  };
  const add = (list, item) => { data[list].push({ ...strip(item), id: crypto.randomUUID() }); commit(); };
  const update = (list, id, patch) => {
    data[list] = data[list].map((x) => (x.id === id ? { ...x, ...strip(patch) } : x));
    commit();
  };
  const remove = (list, ids) => { data[list] = data[list].filter((x) => !ids.includes(x.id)); commit(); };

  return {
    kind: 'local',
    onUser(cb) { cb({ uid: 'demo', email: 'Demo mode (saved in this browser only)' }); return () => {}; },
    signIn: async () => {},
    signOut: async () => { location.href = location.pathname; },
    getIdToken: async () => null,
    subscribe(onChange) { listener = onChange; onChange(structuredClone(data)); return () => {}; },
    addRequest: async (item) => add('requests', item),
    updateRequest: async (id, patch) => update('requests', id, patch),
    deleteRequest: async (id) => remove('requests', [id]),
    addTodo: async (item) => add('todos', item),
    updateTodo: async (id, patch) => update('todos', id, patch),
    deleteTodo: async (id) => remove('todos', [id]),
    deleteTodos: async (ids) => remove('todos', ids),
    saveSettings: async (settings) => { data.settings = settings; commit(); },
  };
}
