# Dooya Connector

This integration drives, from Gladys, the motors paired with a **Dooya Connector**
hub: roller blinds, roller shutters, venetian blinds, awnings, gates and curtains.
The same hub is sold under other brands (Brel, Bloc Blinds, Coulisse Motion, Smart
Blinds…): if your motors are paired in the **Connector** app, this integration speaks
to them.

Everything happens **on your local network**: Gladys talks to the hub on UDP port 32100. No cloud account is used and nothing leaves your home.

## Before you start

1. The hub is set up in the **Connector** app and your motors are paired with it. Give
   each motor its type in the app (roller blind, curtain, venetian blind…): Gladys uses
   it to pick the right card.
2. The hub has a **fixed IP address**: reserve it in your router (DHCP reservation).
   The integration reaches it at that address; if it changes, Gladys loses the hub.
3. Gladys and the hub are on the **same network**.
4. Gladys **5.3.0** or later.

### Getting the key

The hub only takes orders that come with its **key**, 16 characters long:

1. Open the **Connector** app.
2. Go to **Settings** (or **Me**), then **About**.
3. Tap the screen **five times** quickly: the key appears, for example
   `12ab345c-d67e-8f`.

Copy it **exactly**, dashes included: they are part of the 16 characters.

### Getting the IP address

- In the Connector app, the hub details often show its IP address;
- otherwise, in the list of devices connected to your router;
- or press **Find the hub** in the configuration of the integration (see below).

## Configuration

| Field                     | What to enter                                                                  |
| ------------------------- | ------------------------------------------------------------------------------ |
| Hub IP address            | The IPv4 address of the hub, e.g. `192.168.1.50`.                              |
| Connector app key         | The 16-character key (see above). Never written to the logs.                   |
| Refresh interval (s)      | How often the state of each motor is read, 30 to 3600 seconds (60 by default). |
| Low battery threshold (%) | Under this level, the `battery_low` scene trigger fires (20 % by default).     |

Save, then press **Test the connection**: the answer gives the hub address, the number
of motors, the firmware and the Wi-Fi signal, and confirms that the key is accepted.

## Adding the motors

Open the **Discovery** tab of the integration: every motor of the hub is listed. Add
the ones you want, and rename them (the hub has no names: a motor first shows up as
"Roller blind 0001", the last digits of its address).

### What each motor shows

| Feature  | When                           | Values                       |
| -------- | ------------------------------ | ---------------------------- |
| State    | always                         | open / stop / close          |
| Position | the motor reports its position | 0 % (closed) to 100 % (open) |
| Battery  | battery motor                  | 0 to 100 %                   |

A **top down bottom up** blind has two rails, so two states and two positions: "top"
and "bottom".

A one-way radio motor only takes orders: it has no position, and Gladys shows the last
order sent.

### How the state is kept up to date

The hub keeps the last state of each motor in memory. Gladys reads it at the
**refresh interval**: this costs no radio traffic and no battery. After an order from
Gladys, the motor is followed **every 2 seconds** until it stops, so the position
follows the movement.

A motor moved by its remote, the app or a wall switch is seen at the next reading.

The badge on each motor says **local** while the hub answers, **unreachable**
otherwise.

## Actions

In the configuration of the integration:

- **Test the connection**: checks the address and the key, and sums up what the hub
  says.
- **Find the hub**: Gladys broadcasts a discovery request on your network and lists
  the hubs that answer, with their IP address. Some hubs only answer their own
  multicast group and stay silent: read the address in your router then.
- **Identify a motor**: the chosen motor moves one small step up, then back down. Handy
  to know which blind is which.

## Scenes (Gladys 5.1+)

### Scene triggers

| Trigger                      | Key                      | Filters          | Variables                              |
| ---------------------------- | ------------------------ | ---------------- | -------------------------------------- |
| A blind moved without Gladys | `moved_outside_gladys`   | motor, direction | `device_name`, `direction`, `position` |
| A motor battery is low       | `battery_low`            | motor            | `device_name`, `battery`               |
| The hub connection changed   | `hub_connection_changed` | lost / restored  | `status`                               |

- `moved_outside_gladys` fires when a motor comes to rest at a new position after a
  remote, the Connector app or a wall switch moved it. A movement ordered by Gladys
  never fires it (for 2 minutes after the order), so a scene cannot loop.
- `battery_low` fires once when the battery falls under the threshold, then again only
  after it was charged.
- `hub_connection_changed` fires when the hub stops answering (`lost`) and when it
  answers again (`restored`).

Use the variables in the following actions, e.g. `{{triggerEvent.data.device_name}}`.

### Scene actions

| Action                       | Key                 | Parameters             |
| ---------------------------- | ------------------- | ---------------------- |
| Go to the favourite position | `favorite_position` | motor                  |
| Move one step                | `jog`               | motor, up or down      |
| Tilt the slats               | `set_tilt`          | motor, angle 0 to 180° |
| Move every blind             | `move_all`          | open, close or stop    |

`move_all` gives two results to the following actions: `sent` (motors reached) and
`failed` (motors without answer).

To open, close or set the position of one motor, use the standard Gladys "Control
devices" action on its state or position.

## "Dooya Connector" widget

Add it to a dashboard: it shows the position of the first four motors (live), the
hub status (connected or not, number of motors, Wi-Fi signal, firmware), the motors
whose battery is low, and three buttons: **Open all**, **Close all** (asks for a
confirmation) and **Stop all**.

## Good to know

- The hub counts positions from the top (0 = open); Gladys from the bottom
  (100 = open). The integration turns them around: you only see the Gladys way.
- The favourite position is the one saved in the motor (with its remote or the app).
- The integration reads the hub's memory: a motor that lost its radio link with the hub
  keeps its last known state.

## Troubleshooting

| Symptom                                 | What to check                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| "No answer from … on UDP port 32100"    | The IP address, that the hub is powered, on the same network as Gladys, and that no firewall blocks UDP 32100. |
| "The key must be exactly 16 characters" | Copy the key again, dashes included, without spaces.                                                           |
| "The hub answers but refuses the key"   | The key belongs to another hub or was mistyped: copy it again from the app.                                    |
| No motor in the Discovery tab           | Motors must be paired in the Connector app first.                                                              |
| The position does not move              | One-way motors do not report it; for the others, check the motor in the Connector app.                         |
| "Find the hub" finds nothing            | Normal for some hubs: enter the address read in your router.                                                   |

The logs of the integration, in Gladys, say when the hub stops answering and why an
order failed. The key and the tokens are never written
there.
