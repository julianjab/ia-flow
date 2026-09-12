import { describe, expect, it } from 'vitest'
import { parseMessageBlocks } from '../message-blocks.js'

describe('parseMessageBlocks', () => {
  it('deja el texto plano intacto cuando no hay nada estructurado', () => {
    expect(parseMessageBlocks('hola, ¿en qué te ayudo?')).toEqual([
      { type: 'text', text: 'hola, ¿en qué te ayudo?' },
    ])
  })

  it('saca el header "# agentId" que Agent.ts antepone a todo comentario del engine', () => {
    expect(parseMessageBlocks('# chat-assistant\n\n¡Hola! ¿en qué te ayudo?')).toEqual([
      { type: 'text', text: '¡Hola! ¿en qué te ayudo?' },
    ])
  })

  it('extrae negrita y código inline', () => {
    expect(parseMessageBlocks('Label **+critical** y el campo `status`')).toEqual([
      { type: 'text', text: 'Label ' },
      { type: 'bold', text: '+critical' },
      { type: 'text', text: ' y el campo ' },
      { type: 'code', text: 'status' },
    ])
  })

  it('convierte una línea de sólo --- en un divider, sin comerse el texto alrededor', () => {
    expect(parseMessageBlocks('primero\n---\nsegundo')).toEqual([
      { type: 'text', text: 'primero' },
      { type: 'divider' },
      { type: 'text', text: 'segundo' },
    ])
  })

  it('extrae un link markdown inline con su texto y path', () => {
    expect(parseMessageBlocks('Mirá [la tarea](/projects/ia-flow/tareas/42) que falló')).toEqual([
      { type: 'text', text: 'Mirá ' },
      { type: 'link', text: 'la tarea', path: '/projects/ia-flow/tareas/42' },
      { type: 'text', text: ' que falló' },
    ])
  })

  it('ignora un link con URL absoluta — sólo path relativo es válido', () => {
    expect(parseMessageBlocks('[github](https://github.com/x)')).toEqual([
      { type: 'text', text: '[github](https://github.com/x)' },
    ])
  })

  it('parsea un fence ```iaflow:task``` en una task-card', () => {
    const body =
      'Esta es la más urgente:\n' +
      '```iaflow:task\n' +
      '{"title":"Arreglar el login","path":"/projects/ia-flow/tareas/7","status":"Review"}\n' +
      '```\n' +
      '¿la abrís?'
    expect(parseMessageBlocks(body)).toEqual([
      { type: 'text', text: 'Esta es la más urgente:\n' },
      {
        type: 'task-card',
        title: 'Arreglar el login',
        path: '/projects/ia-flow/tareas/7',
        status: 'Review',
      },
      { type: 'text', text: '\n¿la abrís?' },
    ])
  })

  it('parsea un fence ```iaflow:project``` en una project-card', () => {
    const body = '```iaflow:project\n{"name":"ia-flow","path":"/projects/ia-flow/tareas"}\n```'
    expect(parseMessageBlocks(body)).toEqual([
      { type: 'project-card', name: 'ia-flow', path: '/projects/ia-flow/tareas' },
    ])
  })

  it('un fence con JSON inválido se muestra como texto crudo en vez de romper', () => {
    const body = '```iaflow:task\nesto no es json\n```'
    expect(parseMessageBlocks(body)).toEqual([{ type: 'text', text: body }])
  })

  it('un fence sin los campos mínimos se muestra como texto crudo', () => {
    const body = '```iaflow:task\n{"title":"sin path"}\n```'
    expect(parseMessageBlocks(body)).toEqual([{ type: 'text', text: body }])
  })

  it('combina varias task-cards y dividers en el mismo mensaje', () => {
    const body =
      '```iaflow:task\n{"title":"A","path":"/projects/x/tareas/1"}\n```\n' +
      '---\n' +
      '```iaflow:task\n{"title":"B","path":"/projects/x/tareas/2","status":"Blocked"}\n```'
    expect(parseMessageBlocks(body)).toEqual([
      { type: 'task-card', title: 'A', path: '/projects/x/tareas/1', status: undefined },
      { type: 'divider' },
      { type: 'task-card', title: 'B', path: '/projects/x/tareas/2', status: 'Blocked' },
    ])
  })
})
