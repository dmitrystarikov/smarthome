const fs = require('fs');
const http = require('http');
const mqtt = require('mqtt');
const suncalc = require('suncalc');
const winston = require('winston');
const yaml = require('yaml');

var level = 'info';
if (process.env.LOG_LEVEL !== undefined) {
  level = process.env.LOG_LEVEL;
}
const levels = ['info', 'error', 'warn', 'debug'];
if (!(levels.includes(level))) {
  console.log(level + ' is not a valid log_level, use one of ' + levels.join(', '));
}

const logger = winston.createLogger({
  level: level,
  transports: [new winston.transports.Console()]
});

if (fs.existsSync('./config.yml')) {
  var config = yaml.parse(fs.readFileSync('./config.yml', 'utf8'));
} else {
  var config = {
    brightness: {
      down: 18,
      up: 6,
      z: 2.54
    },
    http_addr: '0.0.0.0',
    http_port: 8080,
    latitude: 0,
    longitude: 0,
    mqtt_server: 'mqtt://127.0.0.1:1883',
    options: {
      password: '',
      protocolVersion: 5,
      username: ''
    },
    publish_options: {
      qos: 0
    },
    topics: [],
    unnecessary_payloads: []
  };
}

if (fs.existsSync('./state.yml')) {
  var state = yaml.parse(fs.readFileSync('./state.yml', 'utf8'));
} else {
  var state = {};
}

var stopping = false;

function handleQuit() {
  if (!stopping) {
    stopping = true;
    clearInterval(main);
    http_server.close();
    client.end();
  }
}

function sortJSON(object) {
  if (object instanceof Array) {
    for (var i = 0; i < object.length; i++) {
      object[i] = sortJSON(object[i]);
    }
    return object;
  } else {
    if (typeof object != "object") {
      return object;
    }
  }
  var keys = Object.keys(object);
  keys = keys.sort();
  var newObject = {};
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] != 'sunTimes') {
      newObject[keys[i]] = sortJSON(object[keys[i]]);
    } else {
      newObject[keys[i]] = object[keys[i]];
    }
  }
  return newObject;
}

function state_topic_exist(topic) {
  if (state[topic] === undefined) {
    state[topic] = {};
    return false;
  }
  return true;
}

function drop_unnecessary_payload(message, payload) {
  if (payload !== undefined) {
    if (message[payload] !== undefined) {
      delete message[payload];
    }
  } else {
    for (var unnecessary_payload in config.unnecessary_payloads) {
      if (message[config.unnecessary_payloads[unnecessary_payload]] !== undefined) {
        delete message[config.unnecessary_payloads[unnecessary_payload]];
      }
    }
  }
  return message;
}

function save_occupancy_timeouts(message) {
  for (var device in message.config.devices) {
    var timeouts = message.config.devices[device]['no_occupancy_since'];
    if ( timeouts !== undefined ) {
      var topic = message.config.devices[device]['friendly_name'];
      topic = topic.split("/")[1];
      if ( topic !== undefined ) {
        state_topic_exist(topic);
        state[topic]['occupancy_timeouts'] = timeouts;
      }
    }
  }
}

function save_state(topic, message) {
  if (state_topic_exist(topic)) {
    for (var key in message) {
      state[topic][key] = message[key];
    }
  } else {
    state[topic] = message;
  }
  state = sortJSON(state);
}

function save_state_fs() {
  fs.writeFileSync('./state.yml', yaml.stringify(state), 'utf8')
}

function updateSunTimes() {
  var now = new Date()
  state.sunTimes = suncalc.getTimes(now, config.latitude, config.longitude);
  if ( (now > state.sunTimes.sunriseEnd)
    && (now < state.sunTimes.sunsetStart) ) {
    state.night = false;
  } else {
    state.night = true;
  }
}

function brightness(topic) {
  var brightness = 254;
  if (state_topic_exist(topic)) {
    if (state[topic.split('_')[0]]['adaptive_brightness'] === 'ON') {
      brightness = state.adaptive_brightness;
    }
  }
  return brightness;
}

function generate_adaptive_brightness() {
  var date = new Date();
  var time = date.getHours() + date.getMinutes() / 60;
  var brightness = 0;
  if ( ( (time < (config.brightness.up + config.brightness.down) / 2)
    && (time > (config.brightness.up + config.brightness.down) / 2 - 12) )
    || (time > (config.brightness.up + config.brightness.down) / 2 + 12) ) {
    if (time > config.brightness.down) {
      brightness = Math.atan(time - config.brightness.up - 24);
    } else {
      brightness = Math.atan(time - config.brightness.up);
    }
    brightness = Math.PI / 2 + brightness;
  } else {
    if (time > config.brightness.up) {
      brightness = Math.atan(time - config.brightness.down);
    } else {
      brightness = Math.atan(time - config.brightness.down + 24);
    }
    brightness = Math.PI / 2 - brightness;
  }
  brightness = Math.round(brightness / Math.PI * 100 * config.brightness.z);
  state.adaptive_brightness = brightness;
  update_adaptive_brightness();
}

function get_adaptive_brightness(topic) {
  if (state_topic_exist(topic)) {
    var message = {state: 'OFF'};
    if (state[topic]['adaptive_brightness'] !== undefined) {
      message.state = state[topic]['adaptive_brightness'];
    }
    topic = 'virtual/switch/' + topic;
    client.publish(topic, JSON.stringify(message), config.publish_options);
  }
}

function set_adaptive_brightness(topic, message) {
  message.adaptive_brightness = message.state;
  delete message.state;
  save_state(atopic[2], message);
  for (var light in state) {
    if ( (light.split('_')[0] === topic)
      && (light.split('_')[1] !== undefined) ) {
      if (state[light]['state'] === 'ON') {
        var new_message = {brightness: brightness(topic)};
        new_topic = 'z2m_cc2652p/light/' + light + '/set';
        client.publish(new_topic, JSON.stringify(new_message), config.publish_options);
      }
    }
  }
}

function toggle_adaptive_brightness(topic) {
  if (state_topic_exist(topic)) {
    var message = {state: 'ON'};
    if (state[topic]['adaptive_brightness'] === 'ON') {
      message.state = 'OFF';
    }
    topic = 'virtual/switch/' + topic;
    client.publish(topic, JSON.stringify(message), config.publish_options);
  }
}

function update_adaptive_brightness() {
  for (var light in state) {
    if (light.split('_')[1] !== undefined) {
      if ( (state[light]['state'] === 'ON')
        && (state[light.split('_')[0]]['adaptive_brightness'] === 'ON') ) {
        var message = {brightness: brightness(light)};
        if ( (state[light]['dimmed'] !== true)
          && (state[light]['brightness'] !== message.brightness) ) {
          var topic = 'z2m_cc2652p/light/' + light + '/set';
          client.publish(topic, JSON.stringify(message), config.publish_options);
        }
      }
    }
  }
}

function adjust_brightness(topic) {
  var result = false;
  if (state_topic_exist(topic)) {
    for (var light in state) {
      if ( (light.split('_')[0] === topic)
        && (light.split('_')[1] !== undefined) ) {
        if (state[light]['state'] === 'ON') {
          var message = {brightness: brightness(topic)};
          if (state[light]['brightness'] !== message.brightness) {
            state[light]['dimmed'] = false;
            state[topic]['motion'] = false;
            var new_topic = 'z2m_cc2652p/light/' + light + '/set';
            client.publish(new_topic, JSON.stringify(message), config.publish_options);
            result = true;
          }
        }
      }
    }
  }
  return result;
}

function update_adaptive_lighting(topic, message) {
  if (state_topic_exist(topic)) {
    if (state[topic]['state'] === 'ON') {
      topic = 'z2m_cc2652p/light/' + topic + '/set';
      client.publish(topic, JSON.stringify(message), config.publish_options);
    }
  }
}

function turn_on_light(topic, bulb) {
  var message = {state: 'ON'};
  message.brightness = brightness(topic);
  if (state_topic_exist(topic) === true) {
    if (state[topic]['color_temp'] !== undefined) {
      message.color_temp = state[topic]['color_temp'];
    }
  }
  if (bulb !== undefined) {
    topic = topic + '_' + bulb;
    state_topic_exist(topic);
    state[topic]['dimmed'] = false;
  }
  topic = 'z2m_cc2652p/light/' + topic + '/set';
  client.publish(topic, JSON.stringify(message), config.publish_options);
}

function dim_light(topic, percent, bulb) {
  if (bulb !== undefined) {
    var message = {};
    message.brightness = brightness(topic);
    message.brightness = Math.round(message.brightness * percent * 100);
    topic = topic + '_' + bulb;
    if (state_topic_exist(topic) === true) {
      if ( (state[topic]['state'] === 'ON')
        && (state[topic]['brightness'] !== message.brightness) ) {
        state[topic]['dimmed'] = true;
        topic = 'z2m_cc2652p/light/' + topic + '/set';
        client.publish(topic, JSON.stringify(message), config.publish_options);
      }
    }
  } else {
    for (var light in state) {
      if ( (light.split('_')[0] === topic)
        && (light.split('_')[1] !== undefined) ) {
        dim_light(topic, percent, light.split('_')[1])
      }
    }
  }
}

function turn_off_light(topic, bulb) {
  var message = {state: 'OFF'};
  if (bulb !== undefined) {
    topic = topic + '_' + bulb;
    state[topic]['dimmed'] = false;
  }
  topic = 'z2m_cc2652p/light/' + topic + '/set';
  client.publish(topic, JSON.stringify(message), config.publish_options);
}

function toggle_light(topic) {
  if (state_topic_exist(topic)) {
    state[topic]['motion'] = false;
    if (state[topic]['state'] === 'ON') {
      turn_off_light(topic);
    } else {
      turn_on_light(topic);
    }
  } else {
    turn_on_light(topic);
  }
}

function motion_toggle_light(topic, message) {
  if (message.occupancy === true) {
    if ( (config.motion[topic] === undefined)
      || (config.motion[topic]['night'] !== true)
      || ( (config.motion[topic]['night'] === true)
        && (state.night === true) ) ) {
      state_topic_exist(topic);
      state[topic]['motion'] = true;
      if (config.motion[topic] !== undefined) {
        if (config.motion[topic]['toggleable_lights'] !== undefined) {
          for (var bulb of config.motion[topic]['toggleable_lights']) {
            logger.info('turning on light ' + topic + ' ' + bulb);
            turn_on_light(topic, bulb);
          }
        } else {
          logger.info('turning on light ' + topic);
          turn_on_light(topic);
        }
      } else {
        logger.info('turning on light ' + topic);
        turn_on_light(topic);
      }
    }
  } else if (message.no_occupancy_since !== undefined) {
    if (state_topic_exist(topic)) {
      var timeouts = state[topic]['occupancy_timeouts'];
      if ( (timeouts !== undefined)
        && (state[topic]['motion'] === true) ) {
        if (message.no_occupancy_since === timeouts[timeouts.length - 1]) {
          state[topic]['motion'] = false;
          if (config.motion[topic] !== undefined) {
            if (config.motion[topic]['toggleable_lights'] !== undefined) {
              for (var bulb of config.motion[topic]['toggleable_lights']) {
                logger.info('turning off light ' + topic + ' ' + bulb);
                turn_off_light(topic, bulb);
              }
            } else {
              logger.info('turning off light ' + topic);
              turn_off_light(topic);
            }
          } else {
            logger.info('turning off light ' + topic);
            turn_off_light(topic);
          }
        } else {
          for (var timeout in timeouts) {
            if (message.no_occupancy_since === timeouts[timeout]) {
              var percent = 1 - ((timeout + 1) / timeouts.length);
              if (config.motion[topic] !== undefined) {
                if (config.motion[topic]['toggleable_lights'] !== undefined) {
                  for (var bulb of config.motion[topic]['toggleable_lights']) {
                    logger.info('dimming light ' + topic + ' ' + bulb);
                    dim_light(topic, percent, bulb);
                  }
                } else {
                  logger.info('dimming light ' + topic);
                  dim_light(topic, percent);
                }
              } else {
                logger.info('dimming light ' + topic);
                dim_light(topic, percent);
              }
            }
          }
        }
      }
    }
  } else if (message.occupancy === false) {
    state[topic]['motion'] = false;
    if (config.motion[topic] !== undefined) {
      if (config.motion[topic]['toggleable_lights'] !== undefined) {
        for (var bulb of config.motion[topic]['toggleable_lights']) {
          logger.info('turning off light ' + topic + ' ' + bulb);
          turn_off_light(topic, bulb);
        }
      } else {
        logger.info('turning off light ' + topic);
        turn_off_light(topic);
      }
    } else {
      logger.info('turning off light ' + topic);
      turn_off_light(topic);
    }
  }
}

const client = mqtt.connect(config.mqtt_server, config.options);

client.on('connect', function () {
    client.subscribe(config.topics);
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
          logger.warn('received message in unexpected topic: ' + topic);
          logger.debug(JSON.stringify(message));
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
              logger.warn('received message in unexpected topic: ' + topic);
              logger.debug(JSON.stringify(message));
              break;
          }
          break;
        case 'light':
          message = drop_unnecessary_payload(message, 'color_temp');
          save_state(atopic[2], message);
          break;
        case 'motion':
          motion_toggle_light(atopic[2], message);
          break;
        case 'switch':
          logger.info('received message in topic: ' + topic);
          logger.debug(JSON.stringify(message));
          break;
        default:
          logger.warn('received message in unexpected topic: ' + topic);
          logger.debug(JSON.stringify(message));
          break;
      }
      break;
    default:
      logger.warn('received message in unexpected topic: ' + topic);
      logger.debug(JSON.stringify(message));
      break;
  }

  save_state_fs();
});

const http_server = http.createServer(function(request, response) {
  switch (request.url) {
    case '/config':
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/plain');
      response.end(yaml.stringify(config));
      break;
    case '/state':
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/plain');
      response.end(yaml.stringify(state));
      break;
    default:
      response.statusCode = 404;
      response.setHeader('Content-Type', 'text/plain');
      response.end('404 Not found');
      break;
  }
});

http_server.listen(config.http_port, config.http_addr);

process.on('SIGINT', handleQuit);
process.on('SIGTERM', handleQuit);

function app() {
  updateSunTimes();
  generate_adaptive_brightness();
}

app();
const main = setInterval(app, 60 * 1000);
