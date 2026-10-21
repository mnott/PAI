import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { drainServers } from './drain.js';
import net from 'net';

describe('drainServers', () => {
  let server: http.Server;
  let port: number;

  beforeEach(() => {
    server = http.createServer((req, res) => {
      res.write('chunk1');
      setTimeout(() => {
        res.write('chunk2');
        res.end();
      }, 300);
    });

    server.listen(0); // Use 0 to let OS choose a free port
    port = (server.address() as net.AddressInfo).port;
  });

  afterEach(() => {
    server.close();
  });

  it('should drain servers and wait for in-flight responses to complete', async () => {
    // Start a client request
    const requestStart = Date.now();
    const client = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: '/',
      agent: false,
      headers: { 'connection': 'close' }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        // Verify we received both chunks
        expect(data).toBe('chunk1chunk2');
      });
    });

    client.on('error', (err) => {
      // Handle errors
      throw err;
    });

    client.end();

    // Wait for first chunk to be received
    await new Promise(resolve => setTimeout(resolve, 100));

    // Now drain the server
    const drainStart = Date.now();
    await drainServers([server], { timeoutMs: 120000 });
    const drainEnd = Date.now();

    // Should have waited for the rest of the response: it was due 300 ms after the request, 100 ms of which had passed
    // when the drain began. Measured from the request (not the drain start) with the timer's 1 ms resolution allowed.
    expect(drainEnd - requestStart).toBeGreaterThanOrEqual(300 - 1);

    // Try to connect after drain - should be refused
    const newClient = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: '/',
      agent: false,
      headers: { 'connection': 'close' }
    }, (res) => {
      // This shouldn't be called
      expect.fail('New connection should be refused');
    });

    newClient.on('error', (err: any) => {
      expect(err.code).toBe('ECONNREFUSED');
    });

    newClient.end();
  });

  it('should timeout and close all connections if response never ends', async () => {
    // Create a server that never ends the response
    const slowServer = http.createServer((req, res) => {
      res.write('chunk1');
      // Never end the response
    });

    slowServer.listen(0);
    const slowPort = (slowServer.address() as net.AddressInfo).port;

    // Start a client request
    const client = http.request({
      host: '127.0.0.1',
      port: slowPort,
      method: 'GET',
      path: '/',
      agent: false,
      headers: { 'connection': 'close' }
    }, (res) => {
      // This shouldn't be called
      expect.fail('Should timeout');
    });

    client.on('error', (err) => {
      // This will be called on timeout
    });

    client.end();

    // Drain with a short timeout
    const drainStart = Date.now();
    await drainServers([slowServer], { timeoutMs: 200 });
    const drainEnd = Date.now();

    // Should have timed out and resolved within 1s
    expect(drainEnd - drainStart).toBeLessThan(1000);

    slowServer.close();
  });
});