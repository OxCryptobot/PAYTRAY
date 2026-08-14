import abi from '/tmp/SablierFlow-v3.json' with { type: 'json' }

const entries = Array.isArray(abi) ? abi : abi.abi
for (const entry of entries.filter((item) => item.type === 'event')) {
  console.log(JSON.stringify({ name: entry.name, inputs: entry.inputs }, null, 2))
}
