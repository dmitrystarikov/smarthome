import { connect } from 'mqtt';
var server = 'mqtt://127.0.0.1:1883';
var options = {
  protocolVersion: 5,
  username: '',
  password: ''
};

if (process.env.MQTT_SERVER !== undefined) {
  server = process.env.MQTT_SERVER;
}
if (process.env.MQTT_USER !== undefined) {
  options.username = process.env.MQTT_USER;
}
if (process.env.MQTT_PASSWORD !== undefined) {
  options.password = process.env.MQTT_PASSWORD;
}

publish_options = {
  qos: 2
};
const topics = [
  'virtual/light/+/set',
  'virtual/switch/+',
  'virtual/switch/+/get',
  'z2m_cc2652p/bridge/info',
  'z2m_cc2652p/button/+',
  'z2m_cc2652p/light/+',
  'z2m_cc2652p/motion/+',
  'z2m_cc2652p/switch/+'
];
const unnecessary_payloads = [
  'battery',
  'click',
  'illuminance',
  'illuminance_lux',
  'last_seen',
  'linkquality',
  'voltage'
];

var state = {
  brightness: {
    z: 2.54,
    up: 7,
    down: 20
  }
};

var stopping = false;

function handleQuit() {
  if (!stopping) {
    stopping = true;
    clearInterval(main);
    client.end();
  }
}

function drop_unnecessary_payload(message, payload) {
  if (payload !== undefined) {
    if (message[payload] !== undefined) {
      delete message[payload];
    }
  } else {
    for (var unnecessary_payload in unnecessary_payloads) {
      if (message[unnecessary_payloads[unnecessary_payload]] !== undefined) {
        delete message[unnecessary_payloads[unnecessary_payload]];
      }
    }
  }
  return message;
}

function save_occupancy_timeouts(message) {
  for (var device in message.config.devices) {
    if ( message.config.devices[device]["no_occupancy_since"] === undefined ) {
      break;
    }
    var topic = message.config.devices[device]["friendly_name"];
    topic = topic.split("/")[1];
    if ( topic !== undefined ) {
      state[topic] = message.config.devices[device]["no_occupancy_since"];
    }
  }
  console.log(state);
}

function save_state(topic, message) {
  if (state[topic] === undefined) {
    state[topic] = message;
  } else {
    for (var key in message) {
      state[topic][key] = message[key];
    }
  }
}

function brightness(topic) {
  var brightness = 254;
  if (state[topic] !== undefined) {
    if (state[topic]['adaptive_brightness'] === 'ON') {
      brightness = state.adaptive_brightness;
    }
  }
  return brightness;
}

function generate_adaptive_brightness() {
  var date = new Date();
  var time = date.getHours() + date.getMinutes() / 60;
  var brightness = 0;
  if ( ( (time < (state.brightness.up + state.brightness.down) / 2)
    && (time > (state.brightness.up + state.brightness.down) / 2 - 12) )
    || (time > (state.brightness.up + state.brightness.down) / 2 + 12) ) {
    if (time > state.brightness.down) {
      brightness = Math.atan(time - state.brightness.up - 24);
    } else {
      brightness = Math.atan(time - state.brightness.up);
    }
    brightness = Math.PI / 2 + brightness;
  } else {
    if (time > state.brightness.up) {
      brightness = Math.atan(time - state.brightness.down);
    } else {
      brightness = Math.atan(time - state.brightness.down + 24);
    }
    brightness = Math.PI / 2 - brightness;
  }
  brightness = Math.round(brightness / Math.PI * 100 * state.brightness.z);
  state.adaptive_brightness = brightness;
}

function get_adaptive_brightness(topic) {
  if (state[topic] === undefined) {
    return null;
  }
  var message = {state: 'OFF'};
  if (state[topic]['adaptive_brightness'] !== undefined) {
    message.state = state[topic]['adaptive_brightness'];
  }
  topic = 'virtual/switch/' + topic;
  client.publish(topic, JSON.stringify(message), publish_options);
}

function set_adaptive_brightness(topic, message) {
  message.adaptive_brightness = message.state;
  delete message.state;
  save_state(atopic[2], message);
  for (var light in state) {
    if (light.split('_')[1] === undefined) {
      break;
    }
    if (light.split('_')[0] !== topic) {
      break;
    }
    if (state[light]['state'] === 'ON') {
      var new_message = {brightness: brightness(topic)};
      new_topic = 'z2m_cc2652p/light/' + light + '/set';
      client.publish(new_topic, JSON.stringify(new_message), publish_options);
    }
  }
}

function toggle_adaptive_brightness(topic) {
  if (state[topic] === undefined) {
    return null;
  }
  var message = {state: 'ON'};
  if (state[topic]['adaptive_brightness'] === 'ON') {
    message.state = 'OFF';
  }
  topic = 'virtual/switch/' + topic;
  client.publish(topic, JSON.stringify(message), publish_options);
}

function update_adaptive_brightness() {
  for (var light in state) {
    if (light.split('_')[1] === undefined) {
      break;
    }
    if ( (state[light]['state'] === 'ON')
      && (state[light.split('_')[0]]['adaptive_brightness'] === 'ON') ) {
      var new_message = {brightness: brightness(topic)};
      if (state[light]['brightness'] !== new_message.brightness) {
        var new_topic = 'z2m_cc2652p/light/' + light + '/set';
        client.publish(new_topic, JSON.stringify(new_message), publish_options);
      }
    }
  }
}

function adjust_brightness(topic) {
  var result = false;
  if (state[topic] === undefined) {
    return result;
  }
  for (var light in state) {
    if (light.split('_')[1] === undefined) {
      break;
    }
    if (light.split('_')[0] !== topic) {
      break;
    }
    if (state[light]['state'] === 'ON') {
      var new_message = {brightness: brightness(topic)};
      if (state[light]['brightness'] !== new_message.brightness) {
        var new_topic = 'z2m_cc2652p/light/' + light + '/set';
        client.publish(new_topic, JSON.stringify(new_message), publish_options);
        result = true;
      }
    }
  }
  return result;
}

function update_adaptive_lighting(topic, message) {
  if (state[topic] === undefined) {
    return null;
  }
  if (state[topic]['state'] === 'ON') {
    topic = 'z2m_cc2652p/light/' + topic + '/set';
    client.publish(topic, JSON.stringify(message), publish_options);
  }
}

function toggle_light(topic) {
  var message = {state: 'ON'};
  new_topic = 'z2m_cc2652p/light/' + topic + '/set';
  if (state[topic] !== undefined) {
    if (state[topic]['state'] === 'ON') {
      message.state = 'OFF';
    } else {
      message.brightness = brightness(topic);
      if (state[topic]['color_temp'] !== undefined) {
        message.color_temp = state[topic]['color_temp'];
      }
    }
  }
  client.publish(new_topic, JSON.stringify(message), publish_options);
}

const client = connect(server, options);

client.on('connect', function () {
  for (var topic in topics) {
    client.subscribe(topics[topic]);
  }
});

client.on('message', function (topic, message) {
  if (message.toString() === '') {
    return null;
  }
  atopic = topic.split('/');
  message = JSON.parse(message.toString());
  message = drop_unnecessary_payload(message);
  if (JSON.stringify(message) === '{}') {
    return null;
  }

  switch (atopic[0]) {
    case 'virtual':
      switch (atopic[1]) {
        case 'light':
          save_state(atopic[2], message);
          update_adaptive_lighting(atopic[2], message);
          break;
        case 'switch':
          switch (atopic[3]) {
            case 'get':
              get_adaptive_brightness(atopic[2]);
              break;
            default:
              set_adaptive_brightness(atopic[2], message);
              break;
          }
          break;
        default:
          console.log('received message in unexpected topic: ' + topic);
          console.log(JSON.stringify(message));
          break;
      }
      break;
    case 'z2m_cc2652p':
      switch (atopic[1]) {
        case 'bridge':
          save_occupancy_timeouts(message);
          break;
        case 'button':
          switch (message.action) {
            case 'single':
              toggle_light(atopic[2]);
              break;
            case 'hold':
              if (adjust_brightness(atopic[2]) === false) {
                toggle_adaptive_brightness(atopic[2]);
              }
              break;
            default:
              console.log('received message in unexpected topic: ' + topic);
              console.log(JSON.stringify(message));
              break;
          }
          break;
        case 'light':
          message = drop_unnecessary_payload(message, 'color_temp');
          save_state(atopic[2], message);
          break;
        case 'motion':
          //console.log('received message in topic: ' + topic);
          //console.log(JSON.stringify(message));
          break;
        case 'switch':
          //console.log('received message in topic: ' + topic);
          //console.log(JSON.stringify(message));
          break;
        default:
          console.log('received message in unexpected topic: ' + topic);
          console.log(JSON.stringify(message));
          break;
      }
      break;
    default:
      console.log('received message in unexpected topic: ' + topic);
      console.log(JSON.stringify(message));
      break;
  }
});

process.on('SIGINT', handleQuit);
process.on('SIGTERM', handleQuit);

const main = setInterval(generate_adaptive_brightness, 60 * 1000);