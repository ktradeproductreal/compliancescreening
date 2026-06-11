// Axios instance with JWT injection + 401 handling (PRD §7.1).
import axios from 'axios';

const TOKEN_KEY = 'cp_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
});

// Attach the bearer token to every request.
api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401, drop the token and bounce to /login (unless we're already there).
api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      clearToken();
      if (window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
    }
    return Promise.reject(error);
  },
);

/** Pull a human-readable message out of an axios error. */
export function errorMessage(err, fallback = 'Something went wrong.') {
  return err?.response?.data?.error || err?.message || fallback;
}
